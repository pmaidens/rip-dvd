import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [".next/**", "node_modules/**", "test-results/**"],
  },
  {
    files: ["components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"],
    ignores: ["**/*.test.*", "**/*.test-support.*", "lib/server/**", "app/api/**"],
    languageOptions: { parser: tsParser },
    rules: {
      // Restrict the property regardless of receiver, including aliases,
      // window.crypto, bracket access, and destructured references.
      "no-restricted-properties": ["error", {
        property: "randomUUID",
        message: "The dashboard supports HTTP origins where crypto.randomUUID is unavailable. Use createMutationKey from lib/mutation-key instead.",
      }],
    },
  },
];
