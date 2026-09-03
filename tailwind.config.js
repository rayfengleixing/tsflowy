/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          100: "#E3F6FF",
          500: "#00B5FF",
          600: "#0092D6",
        },
        neutral: {
          100: "#F8FAFF",
          200: "#E4E8F5",
          300: "#CED3E6",
          400: "#B5BBD3",
          500: "#989EB7",
          600: "#6F748C",
          700: "#54596E",
          800: "#3D404F",
          830: "#363845",
          850: "#32343F",
          900: "#272930",
          1000: "#21232A",
        },
      },
      fontFamily: {
        sans: ["Poppins", "system-ui", "sans-serif"],
        mono: ["Roboto Mono", "monospace"],
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
        lg: ["16px", "24px"],
      },
      borderRadius: {
        DEFAULT: "6px",
        input: "8px",
        card: "12px",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
