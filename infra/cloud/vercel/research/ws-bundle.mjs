// Optional native ws peers are not shipped in this self-contained Linux bundle.
// Vite otherwise resolves an absent optional peer to an empty object, which ws
// mistakes for a loaded accelerator. Keep its supported pure JavaScript paths.
export const wsBundleDefines = Object.freeze({
  'process.env.WS_NO_BUFFER_UTIL': '"1"',
  'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
});
