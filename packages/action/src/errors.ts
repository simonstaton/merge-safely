import { CliError, EXIT } from "@merge-safely/cli";

/** A configuration or usage problem the user fixes in the workflow file. Printed as `error [CODE]: message`. */
export function actionError(code: string, message: string, exitCode: number = EXIT.error): CliError {
  return new CliError(code, message, exitCode);
}

/** A GitHub Actions expression as users type it, e.g. ghExpr("secrets.KEY") is the text `${{ secrets.KEY }}`. */
export function ghExpr(inner: string): string {
  return `$\{{ ${inner} }}`;
}
