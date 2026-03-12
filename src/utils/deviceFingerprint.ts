// Realistic Android device profiles for GramJS client spoofing.
// Each profile has correlated deviceModel, systemVersion, appVersion, and langPack
// so the MTProto handshake looks like a consistent real device.
//
// systemVersion follows the format Telegram Android uses:
//   "Android {version}; {model} Build/{build_id}"

type DeviceProfile = {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  systemLangCode: string;
  langPack: string;
};

const APP_VERSIONS = [
  "9.2.1", "9.3.2", "9.4.3", "9.5.5", "9.6.2",
  "9.7.1", "9.7.4", "10.0.1", "10.1.2", "10.1.5",
  "10.2.0", "10.3.1",
] as const;

// Base profiles — appVersion is assigned deterministically per phone below.
// Each entry covers one (device, OS build) combination. Multiple entries exist
// for devices sold with different Android versions in different markets.
const DEVICE_PROFILES: Omit<DeviceProfile, "appVersion">[] = [
  // ── Samsung Galaxy S21 Ultra ────────────────────────────────────────────────
  {
    deviceModel:    "Samsung Galaxy S21 Ultra",
    systemVersion:  "Android 12; Samsung Galaxy S21 Ultra Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Samsung Galaxy S22 ──────────────────────────────────────────────────────
  {
    deviceModel:    "Samsung Galaxy S22",
    systemVersion:  "Android 12; Samsung Galaxy S22 Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },
  {
    deviceModel:    "Samsung Galaxy S22",
    systemVersion:  "Android 13; Samsung Galaxy S22 Build/TP1A.220624.014",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Samsung Galaxy S23 ──────────────────────────────────────────────────────
  {
    deviceModel:    "Samsung Galaxy S23",
    systemVersion:  "Android 13; Samsung Galaxy S23 Build/TP1A.220624.014",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Samsung Galaxy A52 ──────────────────────────────────────────────────────
  {
    deviceModel:    "Samsung Galaxy A52",
    systemVersion:  "Android 11; Samsung Galaxy A52 Build/RP1A.200720.012",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },
  {
    deviceModel:    "Samsung Galaxy A52",
    systemVersion:  "Android 12; Samsung Galaxy A52 Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Samsung Galaxy A53 5G ───────────────────────────────────────────────────
  {
    deviceModel:    "Samsung Galaxy A53 5G",
    systemVersion:  "Android 12; Samsung Galaxy A53 5G Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Xiaomi 12 Pro ───────────────────────────────────────────────────────────
  {
    deviceModel:    "Xiaomi 12 Pro",
    systemVersion:  "Android 12; Xiaomi 12 Pro Build/SKQ1.211006.001",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Xiaomi 13 ───────────────────────────────────────────────────────────────
  {
    deviceModel:    "Xiaomi 13",
    systemVersion:  "Android 13; Xiaomi 13 Build/TKQ1.220905.001",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Redmi Note 11 ───────────────────────────────────────────────────────────
  {
    deviceModel:    "Redmi Note 11",
    systemVersion:  "Android 11; Redmi Note 11 Build/RP1A.200720.011",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Redmi Note 12 ───────────────────────────────────────────────────────────
  {
    deviceModel:    "Redmi Note 12",
    systemVersion:  "Android 12; Redmi Note 12 Build/SKQ1.211006.001",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── POCO X5 Pro ─────────────────────────────────────────────────────────────
  {
    deviceModel:    "POCO X5 Pro",
    systemVersion:  "Android 12; POCO X5 Pro Build/SKQ1.211006.001",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── OnePlus 10 Pro ──────────────────────────────────────────────────────────
  {
    deviceModel:    "OnePlus 10 Pro",
    systemVersion:  "Android 12; OnePlus 10 Pro Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── OnePlus Nord 2T ─────────────────────────────────────────────────────────
  {
    deviceModel:    "OnePlus Nord 2T",
    systemVersion:  "Android 12; OnePlus Nord 2T Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Realme 9 Pro ────────────────────────────────────────────────────────────
  {
    deviceModel:    "Realme 9 Pro",
    systemVersion:  "Android 12; Realme 9 Pro Build/SP1A.210812.016",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },

  // ── Huawei P50 ──────────────────────────────────────────────────────────────
  {
    deviceModel:    "Huawei P50",
    systemVersion:  "Android 11; Huawei P50 Build/HUAWEIP50",
    langCode:       "en",
    systemLangCode: "en-US",
    langPack:       "android",
  },
];

// Derive a stable numeric seed from a phone string so the same phone always
// gets the same profile and app version across restarts.
function phoneToSeed(phone: string): number {
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    hash = (Math.imul(31, hash) + phone.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getDeviceProfile(phone: string): DeviceProfile {
  const seed = phoneToSeed(phone);
  const profile = DEVICE_PROFILES[seed % DEVICE_PROFILES.length];
  const appVersion = APP_VERSIONS[seed % APP_VERSIONS.length];
  return { ...profile, appVersion };
}
