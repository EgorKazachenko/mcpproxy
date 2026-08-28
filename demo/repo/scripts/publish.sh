#!/bin/sh
# Публикация релиза. High-risk по аннотациям: destructiveHint + openWorldHint.
# До этого кода демо не доходит — вызов останавливается на стадии `approval`.
set -u
echo "publish: тег ${1:-нет} ушёл бы в registry.npmjs.org и api.github.com"
exit 0
