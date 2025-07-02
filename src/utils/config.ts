export interface Config {
  tmdbApiKey: string;
  mfpUrl: string;
  mfpPassword: string;
  bothLink: boolean;
  animeUnityEnabled: boolean;
  port: number;
}

export const config: Config = {
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  mfpUrl: process.env.MFP_URL || '',
  mfpPassword: process.env.MFP_PSW || '',
  bothLink: process.env.BOTHLINK === 'true',
  animeUnityEnabled: process.env.ANIMEUNITY_ENABLED === 'true',
  port: parseInt(process.env.PORT || '7860')
};

export const validateConfig = (): boolean => {
  if (!config.tmdbApiKey) {
    console.error('TMDB_API_KEY is required');
    return false;
  }
  
  if (config.animeUnityEnabled && (!config.mfpUrl || !config.mfpPassword)) {
    console.error('MFP_URL and MFP_PSW are required when AnimeUnity is enabled');
    return false;
  }
  
  return true;
};
