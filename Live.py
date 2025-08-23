#!/usr/bin/env python3
"""Live.py

Genera il file JSON dinamico (config/dynamic_channels.json) per l'addon StreamViX
partendo da daddyliveSchedule.json.

Specifiche richieste:
  - Niente M3U8, EPG o riferimenti MFP: solo JSON.
  - Filtra SOLO:
      Italy - Serie A
      Italy - Serie B
      Italy - Serie C
      UEFA Champions League
      UEFA Europa League
      Conference League
      Coppa Italia
      Tennis (solo se esattamente "Tennis")
      motor sports / motorsports (solo eventi MotoGP o F1 / Formula 1)
  - Escludi canali con keyword: college, youth.
  - Loghi:
      Serie A / Serie B: Team1_vs_Team2.png (nomi normalizzati) dal repo
        https://raw.githubusercontent.com/qwertyuiop8899/logo/main
        Normalizzazioni: rimozione prefissi (AS, AC, SSC, etc.), Internazionale -> Inter, AS Roma -> Roma,
        SSC Napoli -> Napoli, rimuovi parola "Calcio".
      Serie C: se evento contiene Salernitana -> Salernitana.png
      Coppe: UEFA_Champions_League.png, UEFA_Europa_League.png, Conference_League.png, Coppa_Italia.png
      F1: F1.png
      MotoGP: MotoGP.png
      Tennis: Tennis.png (se presente, non validiamo l'esistenza in rete).
  - Un logo mancante non blocca l'evento (logo = null).
  - Campi output per ogni evento:
        id, name, streams[{url,title}], logo, category (seriea|serieb|seriec|coppe|tennis|f1|motogp),
        description (Categoria + orario Europe/Rome), eventStart (UTC ISO con Z).
  - Nessun expiresAt: calcolato dall'addon (02:00 Europe/Rome giorno dopo).

Nota tempo: il file originale usa orario UK. Se disponibile pytz convertiamo Europe/London -> UTC.
Altrimenti assumiamo l'orario come UTC.
"""

from __future__ import annotations

import os, re, json, datetime, requests
from typing import Any, Dict, List

try:
    import pytz  # opzionale
    TZ_LONDON = pytz.timezone('Europe/London')
    TZ_ROME = pytz.timezone('Europe/Rome')
    UTC = pytz.UTC
except Exception:  # fallback senza pytz
    pytz = None
    TZ_LONDON = TZ_ROME = UTC = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REMOTE_SCHEDULE_URL = 'https://raw.githubusercontent.com/ciccioxm3/STRTV/main/daddyliveSchedule.json'
OUTPUT_FILE = os.path.join(BASE_DIR, 'config', 'dynamic_channels.json')

LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main'

EXCLUDE_KEYWORDS_CHANNEL = ["college", "youth"]

BASE_CATEGORIES = {
    'Italy - Serie A', 'Italy - Serie B', 'Italy - Serie C',
    'UEFA Champions League', 'UEFA Europa League', 'Conference League', 'Coppa Italia',
    'Tennis', 'motor sports', 'motorsports', 'Motorsport',  # aggiunto 'Motorsport' (singolare) dal sorgente HTML
    # Nuove categorie dirette
    'Basketball', 'Volleyball', 'Ice Hockey', 'Wrestling', 'Boxing', 'Darts', 'WWE', 'Baseball', 'Football'
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
    'Ice Hockey': 'IceHockey.png',  # Nome file da confermare
    'Wrestling': 'Wrestling.png',    # Nome file da confermare
    'WWE': 'Wrestling.png',          # Alias WWE usa stesso logo wrestling
    'Boxing': 'Boxing.png',          # Nome file da confermare
    'MMA': 'Boxing.png',             # Uniforma logo per eventi MMA dentro boxing
    'UFC': 'Boxing.png',             # Uniforma logo per eventi UFC dentro boxing
    'Baseball': 'Baseball.png',
    'NFL': 'NFL.png',
    'Darts': 'Darts.png'             # Nome file da confermare
     
}

MONTHS = {m: i for i, m in enumerate([
    'January','February','March','April','May','June','July','August',
    'September','October','November','December'], start=1)}

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
    'juve stabia': 'juvestabia'
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
    day = day.replace(' - Schedule Time UK GMT', '')
    for suf in ('st','nd','rd','th'):
        day = re.sub(rf'(\d+){suf}', r'\1', day)
    return day.strip()

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

def strip_prefixes(team: str) -> str:
    team = TEAM_PREFIXES_REGEX.sub('', team.strip())
    words = [w for w in re.split(r'\s+', team) if w.lower() not in TEAM_CLEAN_WORDS]
    return ' '.join(words).strip()

def normalize_team(team: str) -> str:
    base = strip_prefixes(team)
    key = base.lower()
    if key in TEAM_SPECIAL:
        return TEAM_SPECIAL[key]
    return base.lower()

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
        # Solo campionato italiano: rilievo su nomi squadre italiane comuni / "Italy" / "Serie A"
        if re.search(r'Italy|SuperLega|Serie A3|Serie A2|Serie A|Modena|Trento|Perugia|Civitanova|Piacenza|Milano|Verona|Monza|Taranto|Cisterna|Padova|Grottazzolina|Cuneo', raw_event, re.IGNORECASE):
            return 'volleyball'
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
SOCCER_CONTAINER_NAMES = { 'soccer' }
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

def extract_event_title(raw_event: str) -> str:
    # se formato "20:00: Juventus vs Inter" -> rimuovi prefisso orario
    if re.match(r'^\d{1,2}:\d{2}:', raw_event):
        return raw_event.split(':', 1)[1].strip()
    return raw_event.strip()

def build_event_id(name: str, start_dt: datetime.datetime) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:60]
    return f"{slug}-{start_dt.strftime('%Y%m%d')}"

def get_stream_url(channel_obj: Any) -> str | None:
    if isinstance(channel_obj, dict) and channel_obj.get('channel_id'):
        return f"https://thedaddy.click/stream/stream-{channel_obj['channel_id']}.php"
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
                        continue  # evento soccer non whitelisted
                    effective_category_src = detected
                else:
                    if not category_whitelisted:
                        continue  # categoria non whitelisted
                # Filtro specifico richiesto: nella categoria Tennis includi SOLO eventi con ATP o WTA nel nome
                if effective_category_src == 'Tennis' and not re.search(r'\b(ATP|WTA|Wimbledon|Australian|Nitto|Garros|Open|King)\b', raw_event, re.IGNORECASE):
                    continue
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
                if pytz and TZ_ROME:
                    rome_dt = start_dt_utc.astimezone(TZ_ROME)
                    # Mostra data + ora locale Roma
                    rome_str = rome_dt.strftime('%d/%m %H:%M')
                else:
                    # Nessuna timezone: mostra solo data senza orario e senza etichetta UTC
                    rome_str = start_dt_utc.strftime('%d/%m')
                title = extract_event_title(raw_event)
                # Prefissi per basket in base alla lega se non già presente
                if mapped_cat == 'basket':
                    if re.search(r'\bNBA\b', raw_event, re.IGNORECASE) and not re.match(r'^NBA\b', title, re.IGNORECASE):
                        title = f"NBA: {title}"
                    elif re.search(r'\bLBA\b', raw_event, re.IGNORECASE) and not re.match(r'^LBA\b', title, re.IGNORECASE):
                        title = f"LBA: {title}"
                    elif re.search(r'Euroleague|Eurolega', raw_event, re.IGNORECASE) and not re.match(r'^(Euroleague|Eurolega)\b', title, re.IGNORECASE):
                        title = f"Euroleague: {title}"
                    elif re.search(r'Coppa Italia', raw_event, re.IGNORECASE) and not re.match(r'^Coppa Italia', title, re.IGNORECASE):
                        title = f"Coppa Italia Basket: {title}"
                logo = build_logo(effective_category_src, raw_event)
                streams_list = []
                for ch in game.get('channels', []):
                    url = get_stream_url(ch)
                    if not url:
                        continue
                    ch_name = ''
                    if isinstance(ch, dict):
                        ch_name = ch.get('channel_name') or f"CH-{ch.get('channel_id','')}"
                    if should_include_channel_text(f"{ch_name} {title} {effective_category_src}"):
                        streams_list.append({'url': url, 'title': ch_name})
                if not streams_list:
                    continue
                event_id = build_event_id(title, start_dt_utc)
                entry = {
                    'id': event_id,
                    'name': title,
                    'streams': streams_list,
                    'logo': logo or None,
                    'category': mapped_cat,
                    'description': f"{effective_category_src} {rome_str}",
                    'eventStart': start_dt_utc.replace(microsecond=0).isoformat().replace('+00:00','Z')
                }
                dynamic_channels.append(entry)
                included += 1

    # Ordina per orario di inizio e secondariamente per nome (stabile)
    dynamic_channels.sort(key=lambda e: (e['eventStart'], e['name'].lower()))

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    try:
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(dynamic_channels, f, ensure_ascii=False, indent=2)
        print(f"Creati {included} eventi dinamici (su {total_events} analizzati) -> {OUTPUT_FILE}")
        # Stampa riepilogo categorie viste (debug)
        print("Categorie viste (dopo cleaning):")
        for k,v in sorted(debug_categories.items()):
            print(f" - {k}: {v} eventi grezzi")
    except Exception as e:
        print(f"Errore scrittura output: {e}")

if __name__ == '__main__':
    main()
