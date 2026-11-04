// Maps WeatherAPI condition codes to local SVG icon filenames
// See: https://www.weatherapi.com/docs/weather_conditions.json

const WEATHER_ICON_BASE_PATH = "/@/static/img/weather";

interface IconMapping {
  day: string;
  night: string;
}

// Complete mapping of all 49 WeatherAPI condition codes
const CONDITION_TO_ICON: Map<number, IconMapping> = new Map([
  // Clear
  [1000, { day: "clear_day.svg", night: "clear_night.svg" }],

  // Partly cloudy
  [1003, { day: "partly_cloudy_day.svg", night: "partly_cloudy_night.svg" }],

  // Cloudy
  [1006, { day: "cloudy.svg", night: "cloudy.svg" }],

  // Overcast
  [1009, { day: "cloudy.svg", night: "cloudy.svg" }],

  // Mist
  [1030, { day: "haze_fog_dust_smoke.svg", night: "haze_fog_dust_smoke.svg" }],

  // Patchy rain possible
  [1063, { day: "scattered_showers_day.svg", night: "scattered_showers_night.svg" }],

  // Patchy snow possible
  [1066, { day: "scattered_snow_showers_day.svg", night: "scattered_snow_showers_night.svg" }],

  // Patchy sleet possible
  [1069, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Patchy freezing drizzle possible
  [1072, { day: "icy.svg", night: "icy.svg" }],

  // Thundery outbreaks possible
  [1087, { day: "isolated_scattered_thunderstorms_day.svg", night: "isolated_scattered_thunderstorms_night.svg" }],

  // Blowing snow
  [1114, { day: "blowing_snow.svg", night: "blowing_snow.svg" }],

  // Blizzard
  [1117, { day: "blizzard.svg", night: "blizzard.svg" }],

  // Fog
  [1135, { day: "haze_fog_dust_smoke.svg", night: "haze_fog_dust_smoke.svg" }],

  // Freezing fog
  [1147, { day: "haze_fog_dust_smoke.svg", night: "haze_fog_dust_smoke.svg" }],

  // Patchy light drizzle
  [1150, { day: "drizzle.svg", night: "drizzle.svg" }],

  // Light drizzle
  [1153, { day: "drizzle.svg", night: "drizzle.svg" }],

  // Freezing drizzle
  [1168, { day: "icy.svg", night: "icy.svg" }],

  // Heavy freezing drizzle
  [1171, { day: "icy.svg", night: "icy.svg" }],

  // Patchy light rain
  [1180, { day: "scattered_showers_day.svg", night: "scattered_showers_night.svg" }],

  // Light rain
  [1183, { day: "showers_rain.svg", night: "showers_rain.svg" }],

  // Moderate rain at times
  [1186, { day: "showers_rain.svg", night: "showers_rain.svg" }],

  // Moderate rain
  [1189, { day: "showers_rain.svg", night: "showers_rain.svg" }],

  // Heavy rain at times
  [1192, { day: "heavy_rain.svg", night: "heavy_rain.svg" }],

  // Heavy rain
  [1195, { day: "heavy_rain.svg", night: "heavy_rain.svg" }],

  // Light freezing rain
  [1198, { day: "icy.svg", night: "icy.svg" }],

  // Moderate or heavy freezing rain
  [1201, { day: "icy.svg", night: "icy.svg" }],

  // Light sleet
  [1204, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Moderate or heavy sleet
  [1207, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Patchy light snow
  [1210, { day: "scattered_snow_showers_day.svg", night: "scattered_snow_showers_night.svg" }],

  // Light snow
  [1213, { day: "showers_snow.svg", night: "showers_snow.svg" }],

  // Patchy moderate snow
  [1216, { day: "showers_snow.svg", night: "showers_snow.svg" }],

  // Moderate snow
  [1219, { day: "showers_snow.svg", night: "showers_snow.svg" }],

  // Patchy heavy snow
  [1222, { day: "heavy_snow.svg", night: "heavy_snow.svg" }],

  // Heavy snow
  [1225, { day: "heavy_snow.svg", night: "heavy_snow.svg" }],

  // Ice pellets
  [1237, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Light rain shower
  [1240, { day: "scattered_showers_day.svg", night: "scattered_showers_night.svg" }],

  // Moderate or heavy rain shower
  [1243, { day: "heavy_rain.svg", night: "heavy_rain.svg" }],

  // Torrential rain shower
  [1246, { day: "heavy_rain.svg", night: "heavy_rain.svg" }],

  // Light sleet showers
  [1249, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Moderate or heavy sleet showers
  [1252, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Light snow showers
  [1255, { day: "scattered_snow_showers_day.svg", night: "scattered_snow_showers_night.svg" }],

  // Moderate or heavy snow showers
  [1258, { day: "heavy_snow.svg", night: "heavy_snow.svg" }],

  // Light showers of ice pellets
  [1261, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Moderate or heavy showers of ice pellets
  [1264, { day: "sleet_hail.svg", night: "sleet_hail.svg" }],

  // Patchy light rain with thunder
  [1273, { day: "isolated_scattered_thunderstorms_day.svg", night: "isolated_scattered_thunderstorms_night.svg" }],

  // Moderate or heavy rain with thunder
  [1276, { day: "strong_thunderstorms.svg", night: "strong_thunderstorms.svg" }],

  // Patchy light snow with thunder
  [1279, { day: "isolated_scattered_thunderstorms_day.svg", night: "isolated_scattered_thunderstorms_night.svg" }],

  // Moderate or heavy snow with thunder
  [1282, { day: "strong_thunderstorms.svg", night: "strong_thunderstorms.svg" }],
]);

// Default fallback icon
const DEFAULT_ICON: IconMapping = { day: "cloudy.svg", night: "cloudy.svg" };

export function getWeatherIconPath(code: number, isDay: boolean = true): string {
  const mapping = CONDITION_TO_ICON.get(code) ?? DEFAULT_ICON;
  const filename = isDay ? mapping.day : mapping.night;
  return `${WEATHER_ICON_BASE_PATH}/${filename}`;
}

export function getWeatherIconFilename(code: number, isDay: boolean = true): string {
  const mapping = CONDITION_TO_ICON.get(code) ?? DEFAULT_ICON;
  return isDay ? mapping.day : mapping.night;
}
