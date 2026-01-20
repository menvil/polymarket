#!/usr/bin/env bash
#
# Lint and auto-fix all packages in the monorepo
#
# Usage:
#   ./scripts/lint-all-packages.sh           # Lint all packages
#   ./scripts/lint-all-packages.sh --fix     # Lint and auto-fix all packages

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
FIX_MODE=""
if [[ "$1" == "--fix" ]]; then
  FIX_MODE=":fix"
  echo -e "${GREEN}Running in FIX mode - will auto-fix linting issues${NC}"
else
  echo -e "${YELLOW}Running in CHECK mode - will only report issues${NC}"
  echo -e "${YELLOW}Use --fix flag to auto-fix issues${NC}"
fi

echo ""

FAILED_PACKAGES=()
SUCCESS_COUNT=0
TOTAL_COUNT=0

# Lint each package (safe iteration for paths with spaces)
while IFS= read -r pkg_file; do
  pkg_dir=$(dirname "$pkg_file")
  pkg_name=$(basename "$pkg_dir")

  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  echo -e "${YELLOW}Linting package: $pkg_name${NC}"
  echo "  Directory: $pkg_dir"

  # Check if package has lint script(s) for the selected mode
  if [[ -n "$FIX_MODE" ]]; then
    # In fix mode, check for fix scripts or fallback scripts
    if ! grep -Eq '"lint:all:fix"|"lint:fix"|"lint:all"|"lint"' "$pkg_file"; then
      echo -e "  ${RED}WARNING: No lint scripts found, skipping...${NC}"
      echo ""
      continue
    fi
  else
    # In check mode, check for check scripts
    if ! grep -Eq '"lint:all"|"lint"' "$pkg_file"; then
      echo -e "  ${RED}WARNING: No 'lint:all' or 'lint' script found, skipping...${NC}"
      echo ""
      continue
    fi
  fi

  # Run lint (with or without fix)
  cd "$pkg_dir"

  if [[ -n "$FIX_MODE" ]]; then
    # Try to run lint:all:fix, fallback to lint:fix
    if grep -q '"lint:all:fix"' "$pkg_file"; then
      if npm run lint:all:fix; then
        echo -e "  ${GREEN}[OK] Linting passed (fixed)${NC}"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      else
        echo -e "  ${RED}[FAIL] Linting failed${NC}"
        FAILED_PACKAGES+=("$pkg_name")
      fi
    elif grep -q '"lint:fix"' "$pkg_file"; then
      if npm run lint:fix; then
        echo -e "  ${GREEN}[OK] Linting passed (fixed)${NC}"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      else
        echo -e "  ${RED}[FAIL] Linting failed${NC}"
        FAILED_PACKAGES+=("$pkg_name")
      fi
    else
      echo -e "  ${YELLOW}WARNING: No 'lint:fix' or 'lint:all:fix' script found; running check-only lint${NC}"
      # Fallback to check mode - still verify the package
      if grep -q '"lint:all"' "$pkg_file"; then
        if npm run lint:all; then
          echo -e "  ${GREEN}[OK] Linting passed${NC}"
          SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
          echo -e "  ${RED}[FAIL] Linting failed${NC}"
          FAILED_PACKAGES+=("$pkg_name")
        fi
      elif npm run lint; then
        echo -e "  ${GREEN}[OK] Linting passed${NC}"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      else
        echo -e "  ${RED}[FAIL] Linting failed${NC}"
        FAILED_PACKAGES+=("$pkg_name")
      fi
    fi
  else
    # Check mode - try lint:all, fallback to lint
    if grep -q '"lint:all"' "$pkg_file"; then
      if npm run lint:all; then
        echo -e "  ${GREEN}[OK] Linting passed${NC}"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      else
        echo -e "  ${RED}[FAIL] Linting failed${NC}"
        FAILED_PACKAGES+=("$pkg_name")
      fi
    else
      if npm run lint; then
        echo -e "  ${GREEN}[OK] Linting passed${NC}"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      else
        echo -e "  ${RED}[FAIL] Linting failed${NC}"
        FAILED_PACKAGES+=("$pkg_name")
      fi
    fi
  fi

  echo ""
done < <(find "$ROOT_DIR/packages" -type f -name "package.json" -not -path "*/node_modules/*" | sort)

# Summary
echo "============================================"
echo -e "${GREEN}Summary:${NC}"
echo "  Total packages: $TOTAL_COUNT"
echo "  Success: $SUCCESS_COUNT"
echo "  Failed: ${#FAILED_PACKAGES[@]}"

if [[ ${#FAILED_PACKAGES[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed packages:${NC}"
  for pkg in "${FAILED_PACKAGES[@]}"; do
    echo "  - $pkg"
  done
  exit 1
fi

echo ""
echo -e "${GREEN}All packages linted successfully!${NC}"