import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  secretKey: process.env.SECRET_KEY,

  // Authentication settings
  auth: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    tokenExpiry: 24 * 60 * 60 * 1000, // 24 hours
  },

  // WebSocket settings
  websocket: {
    pingInterval: 30000, // 30 seconds
    connectionTimeout: 60000, // 60 seconds
    deviceSecret: process.env.WS_DEVICE_SECRET || 'thiyo-remote-device-auth-key-2026',
  },

  // File upload settings
  upload: {
    maxFileSize: 100 * 1024 * 1024, // 100MB
    allowedMimeTypes: [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/3gpp',
      'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg',
      'application/pdf', 'application/zip',
      'application/vnd.android.package-archive', // APK
      'application/octet-stream', // Generic binary — used as fallback for APK/file uploads from device
      'text/plain',
    ],
  },

  // Supabase database
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },

  // Render deployment settings
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};

export default config;
