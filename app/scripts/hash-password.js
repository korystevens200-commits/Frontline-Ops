/* Usage: npm run hash-password -- 'the password'
   Prints the APP_PASSWORD_HASH value. The plaintext never leaves your shell
   and the hash is what goes into `fly secrets set`. */
import { hashPassword } from "../src/auth.js";

const password = process.argv[2];
if (!password) {
  console.error("Usage: npm run hash-password -- 'your password here'");
  process.exit(1);
}
if (password.length < 10) {
  console.error("Refusing: use at least 10 characters. This is the only door.");
  process.exit(1);
}
console.log(await hashPassword(password));
