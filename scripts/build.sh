#!/bin/bash
# Cloudflare Workers build script
# Copies necessary framework files to public directory for asset serving

set -e

echo "Building Scramjet proxy for Cloudflare Workers..."

# Verify source directories exist
for dir in "src/sj-core" "src/baremux" "src/epoxy-transit"; do
  if [ ! -d "$dir" ]; then
    echo "ERROR: Required directory not found: $dir"
    exit 1
  fi
done

# Create necessary directories in public
mkdir -p public/sj-core
mkdir -p public/baremux
mkdir -p public/epoxy-transit

# Copy framework files
echo "Copying Scramjet core files..."
cp -r src/sj-core/* public/sj-core/

echo "Copying BareMux files..."
cp -r src/baremux/* public/baremux/

echo "Copying Epoxy transit files..."
cp -r src/epoxy-transit/* public/epoxy-transit/

echo "Build complete!"
