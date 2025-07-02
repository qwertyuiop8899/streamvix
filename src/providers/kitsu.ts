import axios from 'axios';
import { KitsuAnime } from '../types/animeunity';

const TIMEOUT = 10000;

export class KitsuProvider {
  async getAnimeInfo(kitsuId: string): Promise<{ title: string; date: string } | null> {
    try {
      const response = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
        timeout: TIMEOUT
      });
      
      const data: KitsuAnime = response.data.data;
      const title = data.attributes.titles.en || data.attributes.canonicalTitle;
      const date = data.attributes.startDate;
      
      return { title, date };
    } catch (error) {
      console.error(`Error fetching Kitsu info for ID ${kitsuId}:`, error);
      return null;
    }
  }

  parseKitsuId(kitsuIdString: string): { kitsuId: string; seasonNumber: number | null; episodeNumber: number | null; isMovie: boolean } {
    const parts = kitsuIdString.split(':');
    if (parts.length < 2) {
      throw new Error('Invalid Kitsu ID format. Use: kitsu:ID or kitsu:ID:EPISODE or kitsu:ID:SEASON:EPISODE');
    }
    const kitsuId = parts[1];
    if (parts.length === 2) {
      return { kitsuId, seasonNumber: null, episodeNumber: null, isMovie: true };
    } else if (parts.length === 3) {
      // kitsu:ID:EPISODIO
      return { kitsuId, seasonNumber: null, episodeNumber: parseInt(parts[2]), isMovie: false };
    } else if (parts.length === 4) {
      // kitsu:ID:STAGIONE:EPISODIO
      return { kitsuId, seasonNumber: parseInt(parts[2]), episodeNumber: parseInt(parts[3]), isMovie: false };
    } else {
      throw new Error('Invalid Kitsu ID format');
    }
  }

  normalizeTitle(title: string): string {
    const replacements: Record<string, string> = {
      'Attack on Titan': "L'attacco dei Giganti",
      'Season': '',
      'Shippuuden': 'Shippuden',
      '-': '',
      'Ore dake Level Up na Ken': 'Solo Leveling'
    };
    
    let normalized = title;
    for (const [key, value] of Object.entries(replacements)) {
      normalized = normalized.replace(key, value);
    }
    
    if (normalized.includes('Naruto:')) {
      normalized = normalized.replace(':', '');
    }
  
    //if (normalized.includes("'")) {
    //  normalized = normalized.split("'")[0];
    //}
    
    //if (normalized.includes(':')) {
    //  normalized = normalized.split(':')[0];
    //}
    
    return normalized.trim();
  }
}
