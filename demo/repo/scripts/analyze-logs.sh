#!/bin/sh
# Разбор лога. Читает РОВНО тот файл, который назвали параметром, и ничего не исполняет:
# строки лога здесь данные, а не инструкции.
set -u
file="${1:-}"
if [ -z "$file" ]; then
  echo "analyze-logs: не назван файл" >&2
  exit 2
fi
if [ ! -r "$file" ]; then
  echo "analyze-logs: файл недоступен для чтения: $file" >&2
  exit 3
fi
total=$(wc -l < "$file" | tr -d ' ')
errors=$(grep -c 'ERROR' "$file" || true)
echo "analyze-logs: $file — строк $total, ошибок $errors"
grep 'ERROR' "$file" | head -3
exit 0
