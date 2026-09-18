[eval]:1
process.stdout.write(require('fs').readFileSync(migrations/20260918003000_rater_discord_post_security.sql,'utf8'))
                                                                          ^
Expression expected

SyntaxError: Numeric separators are not allowed at the end of numeric literals
    at makeContextifyScript (node:internal/vm:194:14)
    at compileScript (node:internal/process/execution:388:10)
    at evalTypeScript (node:internal/process/execution:260:22)
    at node:internal/main/eval_string:71:3

Node.js v24.19.0
