#!/usr/bin/env python3
"""Live.py

Genera il file JSON dinamico (config/dynamic_channels.json) per l'addon StreamViX
partendo da daddyliveSchedule.json.

"""

from __future__ import annotations

import os, re, json, datetime, requests
from typing import Any, Dict, List
from pathlib import Path

try:
    import pytz  # opzionale
    TZ_LONDON = pytz.timezone('Europe/London')
    TZ_ROME = pytz.timezone('Europe/Rome')
    UTC = pytz.UTC
except Exception:  # fallback senza pytz
    pytz = None
    TZ_LONDON = TZ_ROME = UTC = None

# Preferisci zoneinfo (stdlib) per gestire sempre il fuso Europe/Rome
try:
    from zoneinfo import ZoneInfo  # Python 3.9+
    ZI_ROME = ZoneInfo('Europe/Rome')
except Exception:
    ZI_ROME = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REMOTE_SCHEDULE_URL = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main/daddyliveSchedule.json'
# Permetti override del percorso di output tramite variabile d'ambiente DYNAMIC_FILE
# Default: usa una posizione scrivibile nel container/host
OUTPUT_FILE = os.environ.get('DYNAMIC_FILE') or '/tmp/dynamic_channels.json'
TV_CHANNELS_DB = os.path.join(BASE_DIR, 'config', 'tv_channels.json')

LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main'

EXCLUDE_KEYWORDS_CHANNEL = ["college", "youth"]

# Filtri richiesti: escludere eventi women / youth / qualificazioni femminili in coppe e Serie A/B/C
# Pattern principali da filtrare nelle competizioni target
_BLOCK_COMPETITION_PATTERNS = [
    r"UEFA\s+Youth\s+League",
    r"UEFA\s+Womens\s+Champions\s+League",
    r"UEFA\s+Women(?:'s)?\s+Champions\s+League",
    r"International\s+Club\s+UEFA\s+Champions\s+League\s+Women\s+Qualification",
    r"UEFA\s+Champions\s+League\s+Women",
    r"AFC\s+Champions\s+League",
]
_BLOCK_GENERIC_TOKENS = [
    r"\bU-?1[6789]\b",  # U16-U19
    r"\bUnder\s*1[6789]\b",
    # Estensione richiesta: blocca anche U20 / U-20 / U21 / U-21 e varianti 'Under 20/21'
    r"\bU-?2[01]\b",  # U20-U21
    r"\bUnder\s*2[01]\b",
    r"\bPrimavera\b",
    r"\bYouth\b",
    r"\bWomen(?:'s)?\b",
    r"\bFemminile\b",
]

_BLOCK_COMPETITION_REGEX = [re.compile(p, re.IGNORECASE) for p in _BLOCK_COMPETITION_PATTERNS]
_BLOCK_TOKEN_REGEX = [re.compile(p, re.IGNORECASE) for p in _BLOCK_GENERIC_TOKENS]

def _is_blocked_women_youth(effective_category_src: str, raw_event: str) -> bool:
    """Ritorna True se l'evento va scartato per le categorie richieste.

    Applichiamo il filtro SOLO se la categoria effettiva (prima del mapping) appartiene a:
      - Italy - Serie A / Serie B / Serie C
      - Competizioni UEFA principali (Champions, Europa, Conference) o loro mapping coppe
    """
    target_cats = {
        'Italy - Serie A', 'Italy - Serie B', 'Italy - Serie C',
        'UEFA Champions League', 'UEFA Europa League', 'Conference League', 'Coppa Italia'
    }
    if effective_category_src not in target_cats:
        return False
    # Match competizioni esplicite
    for rx in _BLOCK_COMPETITION_REGEX:
        if rx.search(raw_event):
            return True
    # Match token generici (youth, women, primavera, ecc.)
    for rx in _BLOCK_TOKEN_REGEX:
        if rx.search(raw_event):
            return True
    return False

BASE_CATEGORIES = {
    'Italy - Serie A', 'Italy - Serie B', 'Italy - Serie C',
    'UEFA Champions League', 'UEFA Europa League', 'Conference League', 'Coppa Italia',
    'Tennis', 'motor sports', 'motorsports', 'Motorsport',  # aggiunto 'Motorsport' (singolare) dal sorgente HTML
    # Nuove categorie dirette
    'Basketball', 'Volleyball', 'Ice Hockey', 'Wrestling', 'Boxing', 'Darts', 'WWE', 'Baseball', 'Football',
    # Nuova categoria generica Soccer (macro contenitore partite internazionali Italy / World / Euro)
    'Soccer'
    , 'MMA', 'UFC',
    # Nuove leghe calcio richieste
    'England - Premier League', 'Spain - Liga', 'Germany - Bundesliga', 'France - Ligue 1'
    # NB: 'Soccer' non è incluso: verrà trattato come contenitore da cui estrarre solo le competizioni whitelisted
}

COPPA_LOGOS = {
    'UEFA Champions League': 'UEFA_Champions_League.png',
    'UEFA Europa League': 'UEFA_Europa_League.png',
    'Conference League': 'Conference_League.png',
    'Coppa Italia': 'Coppa_Italia.png'
}

# Loghi campionati nazionali richiesti (chiavi uguali ai nomi normalizzati)
LEAGUE_LOGOS = {
    'England - Premier League': 'Premier_League.png',
    'Spain - Liga': 'Liga.png',
    'Germany - Bundesliga': 'Bundesliga.png',
    'France - Ligue 1': 'Ligue_1.png',
}

# Loghi aggiuntivi (se presenti nel repo loghi)
EXTRA_LOGOS = {
    'Basketball': 'Basket.png',
    'Volleyball': 'Pallavolo.png',
    'Soccer': 'Soccer.png',
    'Ice Hockey': 'IceHockey.png',  # Nome file da confermare
    'Wrestling': 'Wrestling.png',    # Nome file da confermare
    'WWE': 'Wrestling.png',          # Alias WWE usa stesso logo wrestling
    'Boxing': 'Boxing.png',          # Nome file da confermare
    'MMA': 'Boxing.png',             # Uniforma logo per eventi MMA dentro boxing
    'UFC': 'Boxing.png',             # Uniforma logo per eventi UFC dentro boxing
    'Baseball': 'Baseball.png',
    'NFL': 'NFL.png',
    'NHL': 'NHL.png',
    'Darts': 'Darts.png'             # Nome file da confermare
     
}

# Mappa mesi (nomi completi) + abbreviazioni comuni per evitare fallback di parsing
# Il bug "Lazio vs Roma" nasce perché il day key usa "Sep" (abbreviazione) e la vecchia
# mappa conteneva solo il nome completo -> month/day restavano None e si cadeva nel fallback
# all'UTC now (data errata).
MONTHS = {m: i for i, m in enumerate([
    'January','February','March','April','May','June','July','August',
    'September','October','November','December'], start=1)}
# Aggiungi abbreviazioni (sia forma a 3 lettere sia variante 'Sept')
_MONTHS_ABBR = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Sept': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
}
MONTHS.update(_MONTHS_ABBR)

# Regex per rimuovere suffissi ordinali anche separati da spazi (normali o Unicode)
_ORDINAL_SUFFIX_RX = re.compile(r'(\d{1,2})\s*(?:st|nd|rd|th)\b', re.IGNORECASE)

TEAM_PREFIXES_REGEX = re.compile(
    r'^(?:A\.S\.|AS|A\.C\.|AC|SSC|S\.S\.C\.|SS|U\.S\.|US|U\.C\.|UC|F\.C\.|FC|'
    r'S\.S\.D\.|SSD|A\.S\.D\.|ASD|U\.S\.D\.|USD|Virtus)\s+',
    re.IGNORECASE
)
TEAM_CLEAN_WORDS = {"calcio"}
TEAM_SPECIAL = {
    'internazionale': 'inter',
    'inter': 'inter',
    'juventus': 'juventus',
    'as roma': 'roma',
    'a.s. roma': 'roma',
    'roma': 'roma',
    'ssc napoli': 'napoli',
    's.s.c. napoli': 'napoli',
    'napoli': 'napoli',
    'ss lazio': 'lazio',
     # aggiunte per loghi Serie B
    'virtus entella': 'entella',
    'juve stabia': 'juvestabia',
    # aggiunte Serie A/B per normalizzazioni comuni
    'ac milan': 'milan',
    'a.c. milan': 'milan',
    'milan': 'milan',
    'atalanta bc': 'atalanta',
    'atalanta': 'atalanta',
    'f.c. internazionale': 'inter',
    'hellas verona': 'verona',
    'udinese calcio': 'udinese',
    'genoa cfc': 'genoa',
    'genoa': 'genoa',
    'cagliari calcio': 'cagliari',
    'cagliari': 'cagliari',
    'fiorentina': 'fiorentina',
    'bologna fc': 'bologna',
    'bologna': 'bologna',
    'lecce': 'lecce',
    'empoli': 'empoli',
    'monza': 'monza',
    'sassuolo': 'sassuolo',
    'salernitana': 'salernitana',
    'torino': 'torino',
    'sampdoria': 'sampdoria',
    'parma': 'parma',
    'venezia': 'venezia',
    'cremonese': 'cremonese',
    'palermo': 'palermo',
    'bari': 'bari',
    'como': 'como',
    'cosenza': 'cosenza',
}

MATCH_SPLIT_REGEX = re.compile(r'\bvs\b| - ', re.IGNORECASE)
WOMEN_EVENT_REGEX = re.compile(r"\b(women(?:[’']s)?|femminile|ladies)\b", re.IGNORECASE)
BUNDESLIGA_LOWER_REGEX = re.compile(r"\b(bundesliga\s*[23]|[23]\.?\s*(bundesliga|liga))\b", re.IGNORECASE)

def load_schedule() -> Dict[str, Any]:
    """Scarica SEMPRE il file schedule remoto; nessuna copia locale."""
    resp = requests.get(REMOTE_SCHEDULE_URL, timeout=25)
    resp.raise_for_status()
    return resp.json()

def clean_day_string(day: str) -> str:
    """Normalizza la stringa giorno dal JSON remoto.

    Operazioni:
    1. Rimuove il suffisso fisso finale " - Schedule Time UK GMT" (se presente, case-insensitive).
    2. Normalizza tutti gli spazi Unicode (categoria Zs) in spazio singolo ASCII.
    3. Rimuove eventuali ZERO WIDTH SPACE.
    4. Elimina i suffissi ordinali (st/nd/rd/th) anche se separati da spazi o NBSP dal numero.
    5. Collassa spazi multipli.
    """
    if not isinstance(day, str):
        return ''
    # 1. Rimuovi suffisso fisso se presente
    day = re.sub(r'\s*-\s*Schedule Time UK GMT\s*$', '', day, flags=re.IGNORECASE)

    # 2. Normalizza spazi Unicode (category Zs -> ' ')
    # Evitiamo import aggiuntivi: gestiamo manualmente i principali separatori conosciuti
    # NBSP (\u00A0), NNBSP (\u202F), THIN (\u2009), HAIR (\u200A)
    day = day.replace('\u00A0', ' ').replace('\u202F', ' ').replace('\u2009', ' ').replace('\u200A', ' ')
    # 3. Rimuovi ZERO WIDTH SPACE
    day = day.replace('\u200B', '')

    # 4. Rimuovi suffissi ordinali robustamente
    day = _ORDINAL_SUFFIX_RX.sub(r'\1', day)

    # 5. Collassa spazi multipli ed elimina bordi
    day = re.sub(r'\s+', ' ', day).strip()
    return day

def parse_event_datetime(day_str: str, time_uk: str) -> datetime.datetime:
    day_clean = clean_day_string(day_str)
    parts = day_clean.split()
    month = daynum = year = None
    if len(parts) >= 4:
        if parts[1] in MONTHS:  # Weekday Month Day Year
            month = MONTHS.get(parts[1])
            try: daynum = int(parts[2])
            except: pass
            try: year = int(parts[3])
            except: pass
        elif parts[2] in MONTHS:  # Weekday Day Month Year
            try: daynum = int(parts[1])
            except: pass
            month = MONTHS.get(parts[2])
            try: year = int(parts[3])
            except: pass
    now = datetime.datetime.utcnow()
    month = month or now.month
    daynum = daynum or now.day
    year = year or now.year
    try:
        hour, minute = map(int, time_uk.split(':'))
    except Exception:
        hour, minute = 0, 0
    naive = datetime.datetime(year, month, daynum, hour, minute)
    if pytz and TZ_LONDON:
        aware = TZ_LONDON.localize(naive)
        return aware.astimezone(pytz.UTC)
    return naive.replace(tzinfo=datetime.timezone.utc)

def to_rome(dt_utc: datetime.datetime) -> datetime.datetime:
    """Converte un datetime UTC in Europe/Rome usando zoneinfo se disponibile, altrimenti pytz."""
    try:
        if ZI_ROME is not None:
            return dt_utc.astimezone(ZI_ROME)
    except Exception:
        pass
    if pytz and TZ_ROME:
        try:
            return dt_utc.astimezone(TZ_ROME)
        except Exception:
            pass
    # Fallback: restituisci comunque il dt (potrebbe essere UTC)
    return dt_utc

def strip_prefixes(team: str) -> str:
    team = TEAM_PREFIXES_REGEX.sub('', team.strip())
    words = [w for w in re.split(r'\s+', team) if w.lower() not in TEAM_CLEAN_WORDS]
    return ' '.join(words).strip()

def normalize_team(team: str) -> str:
    base = strip_prefixes(team)
    key = base.lower()
    if key in TEAM_SPECIAL:
        return TEAM_SPECIAL[key]
    # Fuzzy keywords: se contiene una parola chiave di una squadra nota, mappa a quella
    # Copre varianti tipo "Hellas Verona" -> "verona", "Genoa CFC" -> "genoa", ecc.
    TEAM_KEYWORDS = {
        # Serie A
        'juventus': 'juventus', 'napoli': 'napoli', 'inter': 'inter', 'internazionale': 'inter', 'milan': 'milan',
        'atalanta': 'atalanta', 'fiorentina': 'fiorentina', 'bologna': 'bologna', 'torino': 'torino', 'roma': 'roma', 'lazio': 'lazio',
        'udinese': 'udinese', 'monza': 'monza', 'empoli': 'empoli', 'sassuolo': 'sassuolo', 'cagliari': 'cagliari', 'lecce': 'lecce',
        'verona': 'verona', 'hellas': 'verona', 'genoa': 'genoa', 'salernitana': 'salernitana',
        # Serie B (principali)
        'parma': 'parma', 'venezia': 'venezia', 'cremonese': 'cremonese', 'palermo': 'palermo', 'bari': 'bari', 'como': 'como',
        'sampdoria': 'sampdoria', 'cosenza': 'cosenza', 'brescia': 'brescia', 'spezia': 'spezia', 'cittadella': 'cittadella',
        'reggiana': 'reggiana', 'frosinone': 'frosinone', 'pisa': 'pisa', 'modena': 'modena', 'ascoli': 'ascoli', 'ternana': 'ternana',
        'sudtirol': 'sudtirol', 'südtirol': 'sudtirol', 'lecce': 'lecce', 'entella': 'entella', 'juve stabia': 'juvestabia'
    }
    bl = key
    for kw, canon in TEAM_KEYWORDS.items():
        # parola intera o sottostringa robusta
        if re.search(rf"\b{re.escape(kw)}\b", bl):
            return canon
    # fallback: usa l'ultima parola utile (es. "Hellas Verona" -> "verona")
    tokens = [w for w in re.split(r"\s+", bl) if w and w not in TEAM_CLEAN_WORDS]
    if tokens:
        return tokens[-1]
    return bl

def extract_teams(event_name: str) -> tuple[str|None, str|None]:
    parts = MATCH_SPLIT_REGEX.split(event_name)
    if len(parts) >= 2:
        return parts[0].strip(), parts[1].strip()
    return None, None

def build_logo(category_src: str, raw_event: str) -> str | None:
    if category_src in COPPA_LOGOS:
        return f"{LOGO_BASE}/{COPPA_LOGOS[category_src]}"
    if category_src in LEAGUE_LOGOS:
        return f"{LOGO_BASE}/{LEAGUE_LOGOS[category_src]}"
    if category_src in ('motor sports', 'motorsports', 'Motorsport'):
        if re.search(r'\bmotogp\b', raw_event, re.IGNORECASE):
            return f"{LOGO_BASE}/MotoGP.png"
        if re.search(r'\b(f1|formula 1)\b', raw_event, re.IGNORECASE):
            return f"{LOGO_BASE}/F1.png"
        return None
    if category_src == 'Tennis':
        return f"{LOGO_BASE}/Tennis.png"
    if category_src == 'Soccer':
        return f"{LOGO_BASE}/Soccer.png"
    if category_src in EXTRA_LOGOS:
        return f"{LOGO_BASE}/{EXTRA_LOGOS[category_src]}"
    if category_src in ('Italy - Serie A', 'Italy - Serie B'):
        # Estrai porzione dopo l'ultimo ':' (es: "Italy - Serie A : Napoli vs Internazionale" -> "Napoli vs Internazionale")
        teams_segment = raw_event.rsplit(':', 1)[-1].strip() if ':' in raw_event else raw_event
        t1, t2 = extract_teams(teams_segment)
        if t1 and t2:
            n1 = normalize_team(t1)
            n2 = normalize_team(t2)
            # Prima prova: cartella dedicata (SerieA / SerieB) con pattern lowercase team1_vs_team2.png
            subfolder = 'SerieA' if category_src == 'Italy - Serie A' else 'SerieB'
            # Pattern richiesto: squadra1_vs_squadra2.png tutto minuscolo
            match_file = f"{n1}_vs_{n2}.png".replace(' ', '')
            return f"{LOGO_BASE}/{subfolder}/{match_file}"
    if category_src == 'Italy - Serie C':
        teams_segment = raw_event.rsplit(':', 1)[-1].strip() if ':' in raw_event else raw_event
        # Usa Salernitana.png solo se una delle squadre è Salernitana, altrimenti logo generico SerieC.png
        t1, t2 = extract_teams(teams_segment)
        if any(t and re.search(r'salernitana', t, re.IGNORECASE) for t in (t1, t2)):
            return f"{LOGO_BASE}/Salernitana.png"
        return f"{LOGO_BASE}/SerieC.png"
    return None

def map_category(category_src: str, raw_event: str) -> str | None:
    if category_src == 'Italy - Serie A': return 'seriea'
    if category_src == 'Italy - Serie B': return 'serieb'
    if category_src == 'Italy - Serie C': return 'seriec'
    if category_src in COPPA_LOGOS: return 'coppe'
    # Nuove leghe calcio richieste (nomi normalizzati)
    if category_src == 'England - Premier League': return 'premierleague'
    if category_src == 'Spain - Liga': return 'liga'
    if category_src == 'Germany - Bundesliga': return 'bundesliga'
    if category_src == 'France - Ligue 1': return 'ligue1'
    if category_src == 'Tennis': return 'tennis'
    # Normalizzazione categorie motori ("motor sports", "motorsports", "Motorsport")
    norm_motor = category_src.lower().replace(' ', '')
    if norm_motor in ('motorsports', 'motorsport'):
        if re.search(r'\bmotogp\b', raw_event, re.IGNORECASE):
            return 'motogp'
        if re.search(r'\b(f1|formula 1)\b', raw_event, re.IGNORECASE):
            return 'f1'
        return None
    if category_src == 'Basketball':
        # Solo NBA, LBA (Italiano), Euroleague / Eurolega / Coppa Italia Basket
        if re.search(r'\bNBA\b', raw_event, re.IGNORECASE): return 'basket'
        if re.search(r'\bLBA\b', raw_event, re.IGNORECASE): return 'basket'
        if re.search(r'\bFIBA\b', raw_event, re.IGNORECASE): return 'basket'
        if re.search(r'\bEurobasket\b', raw_event, re.IGNORECASE): return 'basket'
        if re.search(r'Euroleague|Eurolega', raw_event, re.IGNORECASE): return 'basket'
        if re.search(r'Coppa Italia', raw_event, re.IGNORECASE): return 'basket'
        return None
    if category_src == 'Volleyball':
        # Estende: eventi Mondiali / Europei / Italia campionato
        if re.search(r'World|Euro|Italy|SuperLega|Serie A3|Serie A2|Serie A|Modena|Trento|Perugia|Civitanova|Piacenza|Milano|Verona|Monza|Taranto|Cisterna|Padova|Grottazzolina|Cuneo', raw_event, re.IGNORECASE):
            return 'volleyball'
        return None
    if category_src == 'Soccer':
        # Categoria generica per partite internazionali (non già catturate da whitelists) con parole chiave Italy / World / Euro
        if re.search(r'Italy|World|Euro', raw_event, re.IGNORECASE):
            return 'soccer'
        return None
    if category_src == 'Ice Hockey':
        # Includi solo eventi NHL: match "NHL" oppure nomi squadre note
        NHL_TEAMS_REGEX = re.compile(r"\b(bruins|sabres|red wings|panthers|canadiens|senators|lightning|maple leafs|hurricanes|blue jackets|devils|islanders|rangers|flyers|penguins|capitals|blackhawks|avalanche|stars|wild|predators|blues|coyotes|flames|oilers|kings|sharks|kraken|canucks|golden knights|jets|nhl)\b", re.IGNORECASE)
        if NHL_TEAMS_REGEX.search(raw_event):
            return 'icehockey'
        return None
    if category_src in ('Wrestling', 'WWE'):
        return 'wrestling'
    # Boxing + MMA aggregati nella stessa categoria "boxing"; includi anche eventi che nel titolo hanno MMA o UFC
    if category_src in ('Boxing', 'MMA', 'UFC') or re.search(r'\b(MMA|UFC)\b', raw_event, re.IGNORECASE):
        return 'boxing'
    if category_src == 'Darts':
        return 'darts'
    if category_src == 'Football':
        # Solo eventi NFL (slug coerente con addon: 'nfl')
        if re.search(r'\bNFL\b', raw_event, re.IGNORECASE): return 'nfl'
        return None
    if category_src == 'Baseball':
        # Solo eventi MLB (pattern copre "MLB" o "Major League Baseball" in qualunque case)
        if re.search(r'\b(MLB|Major League Baseball)\b', raw_event, re.IGNORECASE):
            return 'baseball'
        return None
    return None

def should_include_category(cat: str) -> bool:
    return cat in BASE_CATEGORIES

# Rileva competizioni whitelisted all'interno di un evento della categoria generica "Soccer"
SOCCER_CONTAINER_NAMES = { 'soccer', 'all soccer events' }
INLINE_COMPETITION_PATTERNS = [
    (re.compile(r'\bChampions League\b', re.IGNORECASE), 'UEFA Champions League'),
    (re.compile(r'\bEuropa League\b', re.IGNORECASE), 'UEFA Europa League'),
    (re.compile(r'\bConference League\b', re.IGNORECASE), 'Conference League'),
    (re.compile(r'\bCoppa Italia\b', re.IGNORECASE), 'Coppa Italia'),
    (re.compile(r'Italy\s*-\s*Serie A', re.IGNORECASE), 'Italy - Serie A'),
    (re.compile(r'Italy\s*-\s*Serie B', re.IGNORECASE), 'Italy - Serie B'),
    (re.compile(r'Italy\s*-\s*Serie C', re.IGNORECASE), 'Italy - Serie C'),
    # Varianti senza trattino (es. "Italy Serie A/B/C : ...")
    (re.compile(r'Italy\s+Serie\s*A', re.IGNORECASE), 'Italy - Serie A'),
    (re.compile(r'Italy\s+Serie\s*B', re.IGNORECASE), 'Italy - Serie B'),
    (re.compile(r'Italy\s+Serie\s*C', re.IGNORECASE), 'Italy - Serie C'),
    # Nuove leghe inline dentro Soccer
    (re.compile(r'England\s*-\s*Premier League', re.IGNORECASE), 'England - Premier League'),
    (re.compile(r'Spain\s*-\s*Liga', re.IGNORECASE), 'Spain - Liga'),
    (re.compile(r'Spain\s*-\s*La\s*Liga', re.IGNORECASE), 'Spain - Liga'),
    (re.compile(r'Germany\s*-\s*Bundesliga', re.IGNORECASE), 'Germany - Bundesliga'),
    (re.compile(r'France\s*-\s*Ligue\s*1', re.IGNORECASE), 'France - Ligue 1'),
]

def detect_inline_competition(event_name: str) -> str | None:
    for rx, label in INLINE_COMPETITION_PATTERNS:
        if rx.search(event_name):
            return label
    # Fallback: se compare solo "Bundesliga" senza paese e non è Austria, mappa a Germania
    if re.search(r'\bBundesliga\b', event_name, re.IGNORECASE) and not re.search(r'Austria\s*-\s*Bundesliga', event_name, re.IGNORECASE):
        return 'Germany - Bundesliga'
    return None

def should_include_channel_text(text: str) -> bool:
    tl = text.lower()
    return not any(k in tl for k in EXCLUDE_KEYWORDS_CHANNEL)

def _strip_leading_time_markers(text: str) -> str:
    """Rimuove prefissi di orario e marker tipo "🔴 Inizio: 16:30" o "16:30:"."""
    s = text.strip()
    # Rimuovi qualsiasi occorrenza iniziale del marker "🔴 Inizio: HH:MM" (case-insensitive su Inizio)
    s = re.sub(r'^\s*🔴\s*Inizio\s*:\s*\d{1,2}:\d{2}\s*', '', s, flags=re.IGNORECASE)
    # Rimuovi orario iniziale stile "HH:MM:" o "HH:MM -" o solo "HH:MM "
    s = re.sub(r'^\s*\d{1,2}:\d{2}\s*(?:[:\-–]\s*)?', '', s)
    return s.strip()

def extract_event_title(raw_event: str) -> str:
    # Normalizza rimuovendo eventuali prefissi orari/etichette già presenti
    return _strip_leading_time_markers(raw_event)

# ==========================
# Titolo partite e Vavoo I/O
# ==========================

SOCCER_MAPPED_CATS = {'seriea','serieb','seriec','coppe','premierleague','liga','bundesliga','ligue1'}

def _league_short_and_country(effective_category_src: str) -> tuple[str, str|None]:
    # Restituisce (nome lega breve, paese opzionale)
    m = re.match(r'^(.*?)\s*-\s*(.*)$', effective_category_src)
    if m:
        country = m.group(1).strip()
        league = m.group(2).strip()
        # Normalizza "Liga"/"Ligue 1"/"Serie A/B/C"/"Bundesliga"
        return league, country
    # Coppe UEFA e altre
    return effective_category_src, None

def _teams_from_event(raw_event: str) -> tuple[str|None, str|None]:
    # Usa porzione dopo l'ultimo ':' se presente per evitare prefissi tipo "Italy - Serie A :"
    cleaned = _strip_leading_time_markers(raw_event)
    teams_segment = cleaned.rsplit(':', 1)[-1].strip() if ':' in cleaned else cleaned
    t1, t2 = extract_teams(teams_segment)
    return t1, t2

def build_titles(effective_category_src: str, raw_event: str, rome_dt: datetime.datetime) -> tuple[str, str]:
    """
    Restituisce (external_name, internal_epg_description).
    - Esterno: "⏰ HH:MM : <Match/Title> - <Lega> DD/MM" (senza paese)
    - Interno: "🔴 Inizio: HH:MM - <Match/Title> - <Lega> DD/MM <Paese>" (con paese se presente)
    """
    hhmm = rome_dt.strftime('%H:%M')
    date_str = rome_dt.strftime('%d/%m')
    league_short, country = _league_short_and_country(effective_category_src)
    t1, t2 = _teams_from_event(raw_event)
    if t1 and t2:
        match = f"{t1} vs {t2}"
    else:
        match = extract_event_title(raw_event)
    external = f"⏰ {hhmm} : {match} - {league_short} {date_str}".strip()
    internal = f"🔴 Inizio: {hhmm} - {match} - {league_short} {date_str}"
    if country:
        internal = f"{internal} {country}"
    return external, internal.strip()

# ----- Vavoo helpers -----

_VAVOO_INDEX: Dict[str, str] | None = None  # key: normalized alias, value: canonical alias

def _load_channels_db() -> List[Dict[str, Any]]:
    try:
        with open(TV_CHANNELS_DB, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []

def _norm_vavoo_key(name: str) -> str:
    if not name:
        return ''
    s = name.upper()
    # Normalizza spazi e suffissi qualità/paese
    s = re.sub(r'\b(ITALY|IT|UHD|FHD|HD|SD|4K)\b', ' ', s)
    s = s.replace('DAZN ZONA', 'DAZN 1')
    s = s.replace('Ｈ', 'H')  # wide chars fallback
    s = re.sub(r'[^A-Z0-9]+', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    # Riduzioni per Sky/Eurosport
    # SKY SPORT <num> -> mantieni
    m = re.search(r'\bSKY\s+SPORT\s+(\d{1,3})\b', s)
    if m:
        s = f"SKY SPORT {m.group(1)}"
    # EUROSPORT (1|2)
    m2 = re.search(r'\bEUROSPORT\s*(1|2)\b', s)
    if m2:
        s = f"EUROSPORT {m2.group(1)}"
    return s

def _build_vavoo_index() -> Dict[str, str]:
    idx: Dict[str, str] = {}
    for ch in _load_channels_db():
        aliases = ch.get('vavooNames') or []
        for alias in aliases:
            key = _norm_vavoo_key(alias)
            if key:
                idx[key] = alias.upper()
            # Aggiungi variante DAZN ZONA -> DAZN 1
            if 'DAZN ZONA' in alias.upper():
                idx[_norm_vavoo_key('DAZN 1')] = 'DAZN 1'
    return idx

def _ensure_vavoo_index() -> Dict[str, str]:
    global _VAVOO_INDEX
    if _VAVOO_INDEX is None:
        _VAVOO_INDEX = _build_vavoo_index()
    return _VAVOO_INDEX

def _is_italian_channel_name(name: str) -> bool:
    if not name:
        return False
    s = name.upper()
    if re.search(r'\bIT\b', s):
        return True
    return any(b in s for b in ('SKY', 'DAZN', 'RAI', 'MEDIASET', 'EUROSPORT', 'TV8', 'LA7'))

def find_vavoo_alias_for_channel_name(ch_name: str) -> str | None:
    idx = _ensure_vavoo_index()
    key = _norm_vavoo_key(ch_name)
    if key in idx:
        return idx[key]
    # Heuristic: SKY SPORT CALCIO / F1 / MOTOGP
    for probe in (
        key,
        key.replace(' CALCIO', ''),
        key.replace(' MOTOGP', ''),
        key.replace(' FORMULA 1', ' F1'),
    ):
        if probe in idx:
            return idx[probe]
    return None

def add_vavoo_streams_if_any(streams: List[Dict[str, Any]], candidate_names: List[str]) -> List[Dict[str, Any]]:
    """Ensure a Vavoo entry is present and placed first if we can detect an alias.
    - Prepends a single Vavoo candidate as: {'url': 'vavoo://<alias>', 'title': '[🏠] <alias> (Vavoo)'}
    - Keeps existing order for other streams.
    """
    out = list(streams)
    # Avoid duplicating if already present
    already_has_vavoo = any(isinstance(s, dict) and str(s.get('url','')).startswith('vavoo://') for s in out)
    if already_has_vavoo:
        # If present, move the first Vavoo entry to the front and adjust title
        for i, s in enumerate(out):
            if isinstance(s, dict) and str(s.get('url','')).startswith('vavoo://'):
                alias = s.get('title') or s.get('url','vavoo://').split('vavoo://')[-1]
                s['title'] = f"[🏠] {alias.replace(' (Vavoo)','').strip()} (Vavoo)"
                if i != 0:
                    out.insert(0, out.pop(i))
                return out
        return out
    # Try to detect alias from candidate names
    for name in candidate_names:
        if not name or not _is_italian_channel_name(name):
            continue
        alias = find_vavoo_alias_for_channel_name(name)
        if alias:
            # Prepend Vavoo entry
            out.insert(0, {'url': f'vavoo://{alias}', 'title': f'[🏠] {alias} (Vavoo)'})
            break
    return out

def build_event_id(name: str, start_dt: datetime.datetime) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:60]
    return f"{slug}-{start_dt.strftime('%Y%m%d')}"

def get_stream_url(channel_obj: Any) -> str | None:
    if isinstance(channel_obj, dict) and channel_obj.get('channel_id'):
        return f"https://dlhd.dad/watch.php?id={channel_obj['channel_id']}"
    return None

def main():
    try:
        schedule = load_schedule()
    except Exception as e:
        print(f"Errore download schedule remoto: {e}")
        return

    dynamic_channels: List[Dict[str, Any]] = []
    total_events = 0
    included = 0

    def clean_category_key(raw: str) -> str:
        # Rimuove frammenti HTML come </span> e eventuali tag residui
        c = raw.replace('</span>', '')
        c = re.sub(r'<[^>]+>', '', c)
        c = c.strip()
        # Rimuove eventuale suffisso " :" finale
        c = re.sub(r"\s*:\s*$", '', c)
        # Normalizzazioni note tra sorgente e target
        if c == 'Spain - La Liga':
            c = 'Spain - Liga'
        # Varianti senza trattino: "Italy Serie A/B/C"
        if re.fullmatch(r'(?i)Italy\s+Serie\s*A', c):
            c = 'Italy - Serie A'
        if re.fullmatch(r'(?i)Italy\s+Serie\s*B', c):
            c = 'Italy - Serie B'
        if re.fullmatch(r'(?i)Italy\s+Serie\s*C', c):
            c = 'Italy - Serie C'
        if c == 'Bundesliga':
            c = 'Germany - Bundesliga'
        return c

    debug_categories = {}

    for day, day_data in schedule.items():
        if not isinstance(day_data, dict):
            continue
        for category_src_raw, events in day_data.items():
            category_src = clean_category_key(category_src_raw)
            debug_categories[category_src] = debug_categories.get(category_src, 0) + (len(events) if isinstance(events, list) else 0)
            if not isinstance(events, list):
                continue
            is_soccer_container = category_src.lower() in SOCCER_CONTAINER_NAMES
            category_whitelisted = should_include_category(category_src)
            for game in events:
                total_events += 1
                raw_event = (game.get('event') or '').strip()
                if not raw_event:
                    continue
                effective_category_src = category_src
                if is_soccer_container:
                    detected = detect_inline_competition(raw_event)
                    if not detected:
                        # Fallback nuova categoria Soccer: se contiene parole chiave generiche internazionali includi come "Soccer"
                        if re.search(r'Italy|World|Euro', raw_event, re.IGNORECASE):
                            effective_category_src = 'Soccer'
                        else:
                            continue  # evento soccer non whitelisted e senza parole chiave
                    else:
                        # assegna solo se realmente trovato
                        effective_category_src = detected
                else:
                    if not category_whitelisted:
                        continue  # categoria non whitelisted
                # Filtro specifico richiesto: nella categoria Tennis includi SOLO eventi con ATP o WTA nel nome
                if effective_category_src == 'Tennis' and not re.search(r'\b(ATP|WTA|Wimbledon|Australian|Nitto|Garros|Open|King)\b', raw_event, re.IGNORECASE):
                    continue
                if not effective_category_src:
                    continue  # safety guard
                mapped_cat = map_category(effective_category_src, raw_event)
                if not mapped_cat:
                    continue
                # Escludi eventi femminili per calcio (Serie A/B/C, Coppe, top leghe)
                if mapped_cat in {'seriea','serieb','seriec','coppe','premierleague','liga','bundesliga','ligue1'}:
                    if WOMEN_EVENT_REGEX.search(raw_event):
                        continue
                # Escludi categorie inferiori della Bundesliga (2, 3)
                if mapped_cat == 'bundesliga':
                    if BUNDESLIGA_LOWER_REGEX.search(raw_event) or BUNDESLIGA_LOWER_REGEX.search(effective_category_src):
                        continue
                time_str = game.get('time', '00:00')
                start_dt_utc = parse_event_datetime(day, time_str)
                rome_dt = to_rome(start_dt_utc)
                # Event title/source adjustments (basket prefixes) prima di costruire i titoli
                display_event = raw_event
                if mapped_cat == 'basket':
                    base_title = extract_event_title(raw_event)
                    if re.search(r'\bNBA\b', raw_event, re.IGNORECASE) and not re.match(r'^NBA\b', base_title, re.IGNORECASE):
                        display_event = f"NBA: {base_title}"
                    elif re.search(r'\bLBA\b', raw_event, re.IGNORECASE) and not re.match(r'^LBA\b', base_title, re.IGNORECASE):
                        display_event = f"LBA: {base_title}"
                    elif re.search(r'Euroleague|Eurolega', raw_event, re.IGNORECASE) and not re.match(r'^(Euroleague|Eurolega)\b', base_title, re.IGNORECASE):
                        display_event = f"Euroleague: {base_title}"
                    elif re.search(r'Coppa Italia', raw_event, re.IGNORECASE) and not re.match(r'^Coppa Italia', base_title, re.IGNORECASE):
                        display_event = f"Coppa Italia Basket: {base_title}"
                # Applica filtro eventi women/youth per categorie indicate
                if _is_blocked_women_youth(effective_category_src, raw_event):
                    continue
                external_name, internal_desc = build_titles(effective_category_src, display_event, rome_dt)
                logo = build_logo(effective_category_src, raw_event)
                streams_list = []
                for ch in game.get('channels', []):
                    url = get_stream_url(ch)
                    if not url:
                        continue
                    ch_name = ''
                    if isinstance(ch, dict):
                        ch_name = ch.get('channel_name') or f"CH-{ch.get('channel_id','')}"
                    if should_include_channel_text(f"{ch_name} {external_name} {effective_category_src}"):
                        streams_list.append({'url': url, 'title': ch_name})
                # Aggiungi eventuali canali Vavoo equivalenti (solo canali IT noti)
                if streams_list:
                    candidate_names = [s.get('title','') for s in streams_list]
                    streams_list = add_vavoo_streams_if_any(streams_list, candidate_names)
                if not streams_list:
                    continue
                event_id = build_event_id(external_name, start_dt_utc)
                entry = {
                    'id': event_id,
                    'name': external_name,
                    'streams': streams_list,
                    'logo': logo or None,
                    'category': mapped_cat,
                    'description': internal_desc,
                    'eventStart': start_dt_utc.replace(microsecond=0).isoformat().replace('+00:00','Z')
                }
                dynamic_channels.append(entry)
                included += 1

    # Ordina per orario di inizio e secondariamente per nome (stabile)
    dynamic_channels.sort(key=lambda e: (e['eventStart'], e['name'].lower()))

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    def _atomic_write_json(path_out: str, obj):
        # Scrive in modo atomico: file temporaneo + rename
        tmp_path = f"{path_out}.tmp-{int(datetime.datetime.utcnow().timestamp()*1000)}"
        with open(tmp_path, 'w', encoding='utf-8') as ftmp:
            json.dump(obj, ftmp, ensure_ascii=False, indent=2)
        try:
            os.replace(tmp_path, path_out)  # atomic su stessa FS
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            raise
    try:
        _atomic_write_json(OUTPUT_FILE, dynamic_channels)
        print(f"Creati {included} eventi dinamici (su {total_events} analizzati) -> {OUTPUT_FILE}")
        # Stampa riepilogo categorie viste (debug)
        print("Categorie viste (dopo cleaning):")
        for k,v in sorted(debug_categories.items()):
            print(f" - {k}: {v} eventi grezzi")
        # Post-processing: inject PD streams & update pdUrlF for static channels
        print("[PD][HOOK] Avvio post-processing pig_channels ...")
        print(f"[PD][HOOK] OUTPUT_FILE={OUTPUT_FILE} TV_CHANNELS_DB={TV_CHANNELS_DB}")
        try:
            import importlib, importlib.util, sys as _sys
            if 'pig_channels' in globals() or 'pig_channels' in _sys.modules:
                print("[PD][HOOK] pig_channels già caricato, riutilizzo modulo")
            from pig_channels import run_post_live
            print("[PD][HOOK] run_post_live importato, esecuzione...")
            run_post_live(OUTPUT_FILE, TV_CHANNELS_DB, dry_run=False)
            print("[PD][HOOK] post-processing completato")
        except Exception as e:
            import traceback as _tb
            print(f"[PD][HOOK][ERR] Post-processing failed: {e}")
            _tb.print_exc()
    except Exception as e:
        print(f"Errore scrittura output: {e}")

def _norm_channel_name(name: str) -> str:
    # Normalizza: maiuscolo, rimuove " IT", " HD", " FHD", " SD", "4K", "UHD", spazi multipli
    n = name.upper()
    n = re.sub(r'\bIT\b', '', n)
    n = re.sub(r'\bHD\b|\bFHD\b|\bSD\b|\bUHD\b|\b4K\b', '', n)
    n = re.sub(r'ZONA', '1', n)
    n = re.sub(r'\s+', ' ', n)
    n = n.strip()
    # Sky numerico: "SKY SPORT 251" o "SKY SPORT 1" ecc.
    n = re.sub(r'(\bSKY SPORT\b)\s+(\d{1,3})', r'\1 \2', n)
    # Dazn numerico: "DAZN 1", "DAZN 2" ecc.
    n = re.sub(r'\bDAZN\s+ZONA\b', 'DAZN 1', n)
    # Eurosport numerico: "EUROSPORT 1", "EUROSPORT 2"
    n = re.sub(r'\bEUROSPORT\s+(\d)', r'EUROSPORT \1', n)
    # Rimuovi doppio spazio
    n = re.sub(r'\s+', ' ', n)
    return n.strip()

def _is_italian_channel(ch_obj: dict) -> bool:
    # Considera italiani quelli con vavooNames e non pluto
    cat = ch_obj.get("category")
    cats = set()
    if isinstance(cat, str):
        cats = {cat}
    elif isinstance(cat, list):
        cats = set(cat)
    if "pluto" in {c.lower() for c in cats}:
        return False
    return bool(ch_obj.get("vavooNames"))

def _load_channels_db() -> list:
    cfg = Path(__file__).parent / "config" / "tv_channels.json"
    if not cfg.exists():
        cfg = Path.cwd() / "config" / "tv_channels.json"
    with cfg.open("r", encoding="utf-8") as f:
        return json.load(f)

def find_vavoo_match(channel_name: str, channels_db: list) -> dict | None:
    want = _norm_channel_name(channel_name)
    best = None
    for ch in channels_db:
        if not _is_italian_channel(ch):
            continue
        for vn in ch.get("vavooNames", []):
            vnn = _norm_channel_name(vn)
            if vnn == want:
                return {
                    "channel_name": vnn,
                    "channel_id": f"vavoo:{ch.get('id', vnn)}"
                }
            # fallback: partial match
            if not best and (vnn in want or want in vnn):
                best = {
                    "channel_name": vnn,
                    "channel_id": f"vavoo:{ch.get('id', vnn)}"
                }
    return best

def add_vavoo_channels_if_any(channels: list[dict]) -> list[dict]:
    db = _load_channels_db()
    out = list(channels)
    have_vavoo = {c.get("channel_id") for c in channels if str(c.get("channel_id", "")).startswith("vavoo:")}
    for c in channels:
        name = c.get("channel_name") or ""
        match = find_vavoo_match(name, db)
        if match and match["channel_id"] not in have_vavoo:
            out.append(match)
            have_vavoo.add(match["channel_id"])
    return out

# Esempio d'uso:
# event['channels'] = add_vavoo_channels_if_any(event['channels'])

if __name__ == '__main__':
    # Esegui lo script se invocato direttamente
    try:
        main()
    except Exception as e:
        # Garantisce che eventuali errori non passino silenziosi
        print(f"Errore esecuzione Live.py: {e}")
