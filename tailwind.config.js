/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#edf3ff",
          700: "#244b97",
          800: "#1d3b77",
        },
      },
    },
  },
  plugins: [],
};
