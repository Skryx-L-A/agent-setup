#!/bin/bash
set -euo pipefail

# Brain 3.0 Knowledge Vault Backup Script
# Creates a git bundle of all refs + rsyncs LFS objects
# Retains last 8 weeks, deletes older backups
# Called via launchd weekly (Sunday 04:00)

REPO_DIR="$HOME/Knowledge"
BACKUP_BASE="$HOME/Backups/knowledge-vault"
RETENTION_WEEKS=8
LOG_FILE="$HOME/Library/Logs/knowledge-backup.log"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Ensure repo exists
if [ ! -d "$REPO_DIR/.git" ]; then
  printf "%b\n" "${RED}ERROR: Repository not found at $REPO_DIR${NC}" >> "$LOG_FILE"
  exit 1
fi

# Ensure backup directory exists
mkdir -p "$BACKUP_BASE"

# Get current year-week (ISO 8601)
# YYYY-WW format
YEAR_WEEK=$(date +%Y-%V)
BACKUP_DIR="$BACKUP_BASE/$YEAR_WEEK"
mkdir -p "$BACKUP_DIR"

# Timestamp for logging
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Log function
log() {
  printf "[%s] %s\n" "$TIMESTAMP" "$1" >> "$LOG_FILE"
}

log "Starting Knowledge vault backup"

# Step 1: Create git bundle (all refs)
log "Creating git bundle..."
BUNDLE_FILE="$BACKUP_DIR/knowledge.bundle"

cd "$REPO_DIR"
if git bundle create "$BUNDLE_FILE" --all 2>/dev/null; then
  log "Bundle created: $BUNDLE_FILE"

  # Verify bundle integrity
  if git bundle verify "$BUNDLE_FILE" >/dev/null 2>&1; then
    log "Bundle verification: PASS"
  else
    log "Bundle verification: FAIL"
    exit 1
  fi
else
  log "ERROR: Failed to create bundle"
  exit 1
fi

# Step 2: Backup LFS objects
# LFS objects are stored in .git/lfs/objects/
log "Backing up LFS objects..."
if [ -d "$REPO_DIR/.git/lfs/objects" ]; then
  if rsync -av --delete "$REPO_DIR/.git/lfs/objects/" "$BACKUP_DIR/lfs-objects/" >> "$LOG_FILE" 2>&1; then
    log "LFS objects backed up successfully"
  else
    log "WARNING: LFS rsync had issues (exit code: $?)"
  fi
else
  log "No LFS objects found (normal for new repos)"
fi

# Step 3: Cleanup old backups (keep last 8 weeks)
log "Cleaning up old backups (retention: $RETENTION_WEEKS weeks)..."
CUTOFF_DATE=$(date -v-${RETENTION_WEEKS}w +%s)

for backup_week_dir in "$BACKUP_BASE"/*; do
  [ -d "$backup_week_dir" ] || continue
  basename_dir=$(basename "$backup_week_dir")

  # Parse YYYY-WW format
  if [[ "$basename_dir" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
    # Convert week number to a date (last day of that week) for comparison
    year=${basename_dir:0:4}
    week=${basename_dir:5:2}
    # Get the Friday of that week (last business day)
    date_of_week=$(date -j -f "%Y-%V-%u" "${year}-${week}-5" "+%s" 2>/dev/null || echo "0")

    if [ "$date_of_week" -lt "$CUTOFF_DATE" ]; then
      log "Removing old backup: $basename_dir"
      rm -rf "$backup_week_dir"
    fi
  fi
done

log "Backup completed successfully"
log "Backup location: $BACKUP_DIR"
log "Bundle file: $BUNDLE_FILE ($(du -sh "$BUNDLE_FILE" | awk '{print $1}'))"

if [ -d "$BACKUP_DIR/lfs-objects" ]; then
  log "LFS objects: $(du -sh "$BACKUP_DIR/lfs-objects" | awk '{print $1}')"
fi

exit 0
