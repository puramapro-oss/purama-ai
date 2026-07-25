/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#0A0A0F",
        surface: "#111118",
        "surface-2": "#1A1A24",
        border: "rgba(255,255,255,0.06)",
        accent: "#8B5CF6",
        "accent-light": "#A78BFA",
        "accent-dark": "#6D28D9",
        success: "#10B981",
        warning: "#F59E0B",
        error: "#EF4444",
      },
      fontFamily: {
        syne: ["Syne_700Bold"],
        "syne-regular": ["Syne_400Regular"],
      },
    },
  },
  plugins: [],
};
