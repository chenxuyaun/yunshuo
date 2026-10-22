#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${YUNSHUO_DB_CONTAINER:-yunshuo-db}"
DB_USER="${YUNSHUO_DB_USER:-yunshuo}"
DB_NAME="${YUNSHUO_DB_NAME:-yunshuo}"
OUT_DIR="${YUNSHUO_BACKUP_DIR:-backups}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "未找到数据库容器：$CONTAINER" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/${DB_NAME}-${STAMP}.dump"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom > "$FILE"
docker exec -i "$CONTAINER" pg_restore --list < "$FILE" > /dev/null

BYTES="$(wc -c < "$FILE" | tr -d ' ')"
if [ "$BYTES" -lt 1024 ]; then
  echo "备份文件异常偏小（${BYTES} 字节）：$FILE" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$FILE" > "$FILE.sha256"
fi

echo "备份完成：$FILE（${BYTES} 字节）"
echo "恢复前请先停止 API 与 worker，再执行："
echo "  docker exec -i $CONTAINER pg_restore -U $DB_USER -d $DB_NAME --clean --if-exists < $FILE"
