export const buildConfig = __JUNGLE_BELL_BUILD_CONFIG__;

const SAME_ORIGIN_API_BASE_URL = '';

export const platformApiBaseUrl = buildConfig.target === 'desktop'
    ? buildConfig.platformApiUrl
    : SAME_ORIGIN_API_BASE_URL;
