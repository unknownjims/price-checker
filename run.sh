#!/bin/bash
# Price Checker — Local Server
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║      Price Checker Server               ║"
echo "║                                          ║"
echo "║  Running on http://localhost:5010        ║"
echo "║  Open in Chrome on this device           ║"
echo "║                                          ║"
echo "║  📸 Scan barcodes with camera            ║"
echo "║  ✏️  Learn unknown items (type SKU)      ║"
echo "║  💾 All data stored locally              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

/root/price-checker/venv/bin/python3 app.py 2>/dev/null || python3 app.py 2>/dev/null || python app.py
