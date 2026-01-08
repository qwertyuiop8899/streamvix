
import { Stream } from "stremio-addon-sdk";

interface ProviderResult {
    streams: Stream[];
}

interface SpeedUpOptions {
    enabled?: boolean;
    auPriority?: boolean; // Se true, aspetta AnimeUnity
    type: 'movie' | 'series' | 'anime';
}

/**
 * Gestisce la "gara" tra i provider con logica intelligente.
 * - Se Speed Up è DISABILITATO: si comporta come Promise.all (aspetta tutti).
 * - Se Speed Up è ABILITATO:
 *      - Movie/Series: ritorna appena un provider "veloce" (VixSrc, GuardaHD, Guardaserie) risponde.
 *      - Anime:
 *          - Default: Ritorna il primo che risponde (qualsiasi).
 *          - Priority AU: Aspetta AnimeUnity (fino a timeout), poi fallback.
 */
export async function raceWithPriority(
    promises: Promise<void>[],
    resultsArray: Stream[],
    options: SpeedUpOptions
): Promise<void> {

    if (!options.enabled) {
        // Comportamento standard: aspetta tutti
        await Promise.all(promises);
        return;
    }

    // Wrap delle promise per tracciare il completamento e il provider
    // Nota: i provider scrivono direttamente in resultsArray (side-effect), 
    // quindi qui monitoriamo solo quando finiscono.

    return new Promise<void>((resolve) => {
        let completedCount = 0;
        const total = promises.length;
        let resolved = false;

        // Helper per risolvere e chiudere
        const finish = () => {
            if (!resolved) {
                resolved = true;
                resolve();
            }
        };

        // Timeout di sicurezza generale (es. 45s) per non rimanere appesi per sempre
        const safetyTimeout = setTimeout(finish, 45000);

        // Au Priority Timeout (25s)
        let auTimeout: NodeJS.Timeout | null = null;
        if (options.type === 'anime' && options.auPriority) {
            auTimeout = setTimeout(() => {
                // Se passano 25s e AnimeUnity non ha risposto (o non ha trovato nulla),
                // sblocca la coda e prendi quello che c'è.
                finish();
            }, 25000);
        }

        promises.forEach((p, index) => {
            p.then(() => {
                completedCount++;

                if (resolved) return;

                // Controlla se abbiamo ottenuto risultati "Buoni" per uscire subito
                const hasVixSrc = resultsArray.some(s => (s.name || '').toLowerCase().includes('vixsrc'));
                const hasGuardaHD = resultsArray.some(s => (s.name || '').toLowerCase().includes('guardahd'));
                const hasGuardaSerie = resultsArray.some(s => (s.name || '').toLowerCase().includes('guardaserie'));
                const hasAnimeUnity = resultsArray.some(s => (s.name || '').toLowerCase().includes('animeunity'));

                // Logica Speed Up
                if (options.type === 'movie') {
                    // Film: Priorità VixSrc o GuardaHD
                    if (hasVixSrc || hasGuardaHD) finish();
                } else if (options.type === 'series') {
                    // Serie: Priorità VixSrc o Guardaserie
                    if (hasVixSrc || hasGuardaSerie) finish();
                } else if (options.type === 'anime') {
                    if (options.auPriority) {
                        // Priority AU: Esce SOLO se c'è AnimeUnity
                        if (hasAnimeUnity) {
                            if (auTimeout) clearTimeout(auTimeout);
                            finish();
                        }
                        // Altrimenti aspetta (fino al timeout o alla fine di tutti)
                    } else {
                        // Anime Default: Esce al PRIMO risultato utile (qualsiasi)
                        if (resultsArray.length > 0) finish();
                    }
                }

                // Se tutti hanno finito, chiudi
                if (completedCount === total) finish();
            }).catch(() => {
                completedCount++;
                if (completedCount === total) finish();
            });
        });
    });
}
