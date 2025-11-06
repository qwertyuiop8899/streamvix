/**
 * Mappa statica di normalizzazione titoli per Loonex
 * Usa questo file per aggiungere mappature quando il titolo IMDb/TMDb
 * è diverso dal titolo usato su Loonex
 * 
 * Formato: 'ID_IMDB_o_TMDB': 'Titolo Esatto Su Loonex'
 */

export const LOONEX_TITLE_MAP: Record<string, string> = {
    // Esempi di mappature
    'tt4788708': 'over the garden wall',
    'tt3718778': 'over the garden wall',  // IMDb per Over the Garden Wall
    '61617': 'over the garden wall',      // TMDb per Over the Garden Wall
    // 'tt1234567': 'titolo esatto sul sito',
    
    // Aggiungi qui altre mappature quando necessario
    // Puoi usare sia IMDb ID (tt...) che TMDb ID
};

/**
 * Cerca un titolo normalizzato dato un IMDb ID o TMDb ID
 */
export function getLoonexTitle(imdbId?: string, tmdbId?: string): string | undefined {
    if (imdbId && LOONEX_TITLE_MAP[imdbId]) {
        return LOONEX_TITLE_MAP[imdbId];
    }
    if (tmdbId && LOONEX_TITLE_MAP[tmdbId]) {
        return LOONEX_TITLE_MAP[tmdbId];
    }
    return undefined;
}
