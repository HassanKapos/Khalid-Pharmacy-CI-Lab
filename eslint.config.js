import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*', 'android/**/*', '.tmp-web-ocr/**/*'],
  },
  firebaseRulesPlugin.configs['flat/recommended'],
];
