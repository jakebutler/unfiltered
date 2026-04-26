import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".open-next/**",
      ".next/**",
      "node_modules/**",
      "legacy-prompt-specs/**",
      "db/migrations/**",
    ],
  },
];

export default eslintConfig;
