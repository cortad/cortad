# The Cortad action

Your app has to be running before this step. Starting it inside the action would hide the failure
that matters most, which is an app that never answered.

```yaml
- run: npm run dev &
- run: npx wait-on http://localhost:3000
- uses: cortad/cortad/action@v1
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: cortad.sarif
```

With the SARIF upload, every question answered the wrong way appears on a line in the pull request:
on the line of your code the app's own trace names, or on the simulation that asked it.

The step exits non-zero when a question failed and when your app answered nothing, so it gates the
merge as it is.

Scope it to what changed:

```yaml
- uses: cortad/cortad/action@v1
  with:
    changed: ${{ steps.diff.outputs.files }}
```

A file no simulation reaches fails the step and says to write one, rather than passing on coverage
that does not exist.
