import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

// eslint-config-next 15 ships eslintrc-format configs, not flat-config arrays.
// create-next-app generated a config that imported them as arrays, which fails
// at load. FlatCompat is the bridge Next documents for v15.
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"],
  },
];

export default eslintConfig;
