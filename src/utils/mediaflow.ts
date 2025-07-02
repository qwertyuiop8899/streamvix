export const formatMediaFlowUrl = (mp4Url: string, mfpUrl: string, mfpPassword: string): string => {
  let cleanUrl = mp4Url;
  let filename = '';
  try {
    const urlObj = new URL(mp4Url);
    filename = urlObj.searchParams.get('filename') || '';
    urlObj.searchParams.delete('filename');
    cleanUrl = urlObj.toString();
  } catch (e) {
    // fallback: se non è un URL valido, usa l'originale
  }
  const encodedUrl = encodeURIComponent(cleanUrl);
  if (!filename) {
    // Estrai il filename dal path se non presente come parametro
    const urlPath = (() => {
      try {
        return new URL(cleanUrl).pathname;
      } catch {
        return cleanUrl;
      }
    })();
    filename = urlPath.split('/').pop() || 'video.mp4';
  }
  // Normalizza mfpUrl rimuovendo lo slash finale se presente
  const normalizedMfpUrl = mfpUrl.endsWith('/') ? mfpUrl.slice(0, -1) : mfpUrl;
  return `${normalizedMfpUrl}/proxy/stream/${filename}?d=${encodedUrl}&api_password=${mfpPassword}`;
};
