#!/usr/bin/env python3
"""Price Checker — Flask-based PWA for retail price checking."""

import csv
import io
import os
from datetime import datetime, date

from flask import (
    Flask, render_template, request, jsonify, send_file, make_response
)
from models import db, Product, PriceList, PriceListItem, ScanLog
from models import lookup_barcode, check_active_prices, import_csv_stream

app = Flask(__name__)

# Config
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'price-checker-dev-key-2025')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///price_checker.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max upload

db.init_app(app)

# ─── Helpers ────────────────────────────────────────────────────────────────

def calculate_discount_pct(original, sale):
    if original and original > 0:
        return round((1 - sale / original) * 100, 1)
    return None


def serialize_price_info(product, active_prices):
    """Build a response dict with product info and active sale/promotion data."""
    result = product.to_dict()
    result['has_active_price'] = bool(active_prices)
    result['selling_price'] = product.current_price
    result['price_breakdown'] = []

    for pl, item in active_prices:
        discount_pct = calculate_discount_pct(item.original_price, item.sale_price)
        entry = {
            'list_id': pl.id,
            'list_name': pl.name,
            'list_type': pl.type,
            'original_price': item.original_price,
            'sale_price': item.sale_price,
            'discount_pct': discount_pct or item.discount_pct,
            'end_date': pl.end_date.isoformat() if pl.end_date else None,
            'days_remaining': None,
        }
        if pl.end_date:
            delta = (pl.end_date - date.today()).days
            entry['days_remaining'] = max(0, delta)
        result['price_breakdown'].append(entry)

        # Lowest sale price wins as the selling price
        if item.sale_price < (result['selling_price'] or float('inf')):
            result['selling_price'] = item.sale_price

    return result


# ─── Routes: Pages ──────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/products')
def products_page():
    return render_template('products.html')


@app.route('/lists')
def lists_page():
    return render_template('lists.html')


@app.route('/settings')
def settings_page():
    return render_template('settings.html')


# ─── API: Scanning ──────────────────────────────────────────────────────────

@app.route('/api/scan', methods=['POST'])
def api_scan():
    data = request.get_json()
    if not data or 'barcode' not in data:
        return jsonify({'error': 'Missing barcode'}), 400

    barcode = data['barcode'].strip()
    product, active_prices = lookup_barcode(barcode)

    # Log the scan
    scan_log = ScanLog(barcode=barcode, found=product is not None)
    db.session.add(scan_log)
    db.session.commit()

    if not product:
        return jsonify({
            'found': False,
            'barcode': barcode,
            'message': 'Unknown barcode. Use learning mode to add it.'
        })

    return jsonify({
        'found': True,
        'product': serialize_price_info(product, active_prices)
    })


# ─── API: Learning Mode ─────────────────────────────────────────────────────

@app.route('/api/learn', methods=['POST'])
def api_learn():
    data = request.get_json()
    if not data or 'barcode' not in data:
        return jsonify({'error': 'Missing barcode'}), 400

    barcode = data['barcode'].strip()
    sku = data.get('sku', '').strip() or None
    description = data.get('description', '').strip() or None
    department = data.get('department', '').strip() or None
    current_price = data.get('current_price')

    if current_price is not None:
        try:
            current_price = float(current_price)
        except (ValueError, TypeError):
            current_price = None

    product = Product.query.filter_by(barcode=barcode).first()
    if product:
        if sku:
            product.sku = sku
        if description:
            product.description = description
        if department:
            product.department = department
        if current_price is not None:
            product.current_price = current_price
        product.last_updated = datetime.utcnow()
        msg = 'Product updated'
    else:
        product = Product(
            barcode=barcode,
            sku=sku,
            description=description,
            department=department,
            current_price=current_price,
            last_updated=datetime.utcnow()
        )
        db.session.add(product)
        msg = 'Product learned'

    db.session.commit()
    return jsonify({'success': True, 'message': msg, 'product': product.to_dict()})


# ─── API: Import ────────────────────────────────────────────────────────────

@app.route('/api/import/csv', methods=['POST'])
def api_import_csv():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400

    barcode_col = int(request.form.get('barcode_col', 0))
    sku_col = int(request.form.get('sku_col', 1))
    desc_col_str = request.form.get('desc_col', '')
    desc_col = int(desc_col_str) if desc_col_str else None
    has_header = request.form.get('has_header', 'true').lower() == 'true'
    delim = request.form.get('delimiter', ',')

    try:
        imported, skipped, errors = import_csv_stream(
            file.stream, has_header, barcode_col, sku_col, desc_col, delim
        )
        return jsonify({
            'success': True,
            'imported': imported,
            'skipped': skipped,
            'errors': errors[:20],
            'total_errors': len(errors)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/import/stocktake', methods=['POST'])
def api_import_stocktake():
    """Flexible stock take import — user specifies column mapping."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    barcode_col = int(request.form.get('barcode_col', 0))
    sku_col_str = request.form.get('sku_col', '')
    sku_col = int(sku_col_str) if sku_col_str else None
    has_header = request.form.get('has_header', 'true').lower() == 'true'
    delim = request.form.get('delimiter', ',')

    imported = 0
    skipped = 0
    errors = []

    try:
        content = file.stream.read().decode('utf-8')
        reader = csv.reader(io.StringIO(content), delimiter=delim)

        for row_idx, row in enumerate(reader):
            if not row or (row_idx == 0 and has_header):
                continue
            try:
                barcode = row[barcode_col].strip()
                sku = row[sku_col].strip() if sku_col is not None and len(row) > sku_col else None

                if not barcode:
                    continue

                existing = Product.query.filter_by(barcode=barcode).first()
                if existing:
                    if sku:
                        existing.sku = sku
                    existing.last_updated = datetime.utcnow()
                    skipped += 1
                else:
                    product = Product(
                        barcode=barcode,
                        sku=sku,
                        last_updated=datetime.utcnow()
                    )
                    db.session.add(product)
                    imported += 1
            except Exception as e:
                errors.append(f"Row {row_idx + 1}: {str(e)}")

        db.session.commit()
        return jsonify({
            'success': True,
            'imported': imported,
            'skipped': skipped,
            'errors': errors[:20],
            'total_errors': len(errors)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ─── API: Products ──────────────────────────────────────────────────────────

@app.route('/api/products/search', methods=['GET'])
def api_search_products():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'products': []})

    products = Product.query.filter(
        db.or_(
            Product.barcode.like(f'%{q}%'),
            Product.sku.like(f'%{q}%'),
            Product.description.like(f'%{q}%'),
            Product.department.like(f'%{q}%')
        )
    ).limit(50).all()

    return jsonify({'products': [p.to_dict() for p in products]})


@app.route('/api/products', methods=['GET'])
def api_list_products():
    department = request.args.get('department')
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)

    query = Product.query
    if department:
        query = query.filter_by(department=department)

    pagination = query.order_by(Product.last_updated.desc()).paginate(
        page=page, per_page=per_page, error_out=False
    )

    return jsonify({
        'products': [p.to_dict() for p in pagination.items],
        'total': pagination.total,
        'page': pagination.page,
        'pages': pagination.pages
    })


# ─── API: Price Lists ───────────────────────────────────────────────────────

@app.route('/api/lists', methods=['GET'])
def api_list_lists():
    lists = PriceList.query.order_by(PriceList.created_at.desc()).all()
    return jsonify({'lists': [pl.to_dict() for pl in lists]})


@app.route('/api/lists', methods=['POST'])
def api_create_list():
    data = request.get_json()
    if not data or 'name' not in data or 'type' not in data:
        return jsonify({'error': 'Missing required fields: name, type'}), 400

    list_type = data['type']
    if list_type not in ('markdown', 'promotion'):
        return jsonify({'error': 'Type must be "markdown" or "promotion"'}), 400

    end_date = None
    if data.get('end_date'):
        try:
            end_date = datetime.strptime(data['end_date'], '%Y-%m-%d').date()
        except ValueError:
            return jsonify({'error': 'Invalid end_date format. Use YYYY-MM-DD'}), 400

    effective_date = None
    if data.get('effective_date'):
        try:
            effective_date = datetime.strptime(data['effective_date'], '%Y-%m-%d').date()
        except ValueError:
            return jsonify({'error': 'Invalid effective_date format. Use YYYY-MM-DD'}), 400

    # Promotions must have an end date
    if list_type == 'promotion' and not end_date:
        return jsonify({'error': 'Promotions must have an end date'}), 400

    price_list = PriceList(
        name=data['name'],
        type=list_type,
        effective_date=effective_date,
        end_date=end_date,
        active=data.get('active', True)
    )
    db.session.add(price_list)
    db.session.commit()

    return jsonify({'success': True, 'list': price_list.to_dict()}), 201


@app.route('/api/lists/<int:list_id>/items', methods=['POST'])
def api_upload_list_items(list_id):
    price_list = PriceList.query.get_or_404(list_id)

    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    has_header = request.form.get('has_header', 'true').lower() == 'true'
    delim = request.form.get('delimiter', ',')

    sku_col = int(request.form.get('sku_col', 0))
    price_col = int(request.form.get('price_col', 1))
    original_price_col_str = request.form.get('original_price_col', '')
    original_price_col = int(original_price_col_str) if original_price_col_str else None

    added = 0
    errors = []

    try:
        content = file.stream.read().decode('utf-8')
        reader = csv.reader(io.StringIO(content), delimiter=delim)

        for row_idx, row in enumerate(reader):
            if not row or (row_idx == 0 and has_header):
                continue
            try:
                sku = row[sku_col].strip()
                sale_price = float(row[price_col].strip())

                original_price = None
                if original_price_col is not None and len(row) > original_price_col:
                    try:
                        original_price = float(row[original_price_col].strip())
                    except (ValueError, IndexError):
                        pass

                discount_pct = calculate_discount_pct(original_price, sale_price)

                # Check if item already exists for this list
                existing = PriceListItem.query.filter_by(
                    list_id=list_id, sku=sku
                ).first()
                if existing:
                    existing.sale_price = sale_price
                    existing.original_price = original_price or existing.original_price
                    existing.discount_pct = discount_pct
                else:
                    item = PriceListItem(
                        list_id=list_id,
                        sku=sku,
                        original_price=original_price,
                        sale_price=sale_price,
                        discount_pct=discount_pct
                    )
                    db.session.add(item)

                added += 1
            except Exception as e:
                errors.append(f"Row {row_idx + 1}: {str(e)}")

        db.session.commit()
        return jsonify({
            'success': True,
            'added': added,
            'errors': errors[:20],
            'total_errors': len(errors)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/lists/<int:list_id>/toggle', methods=['POST'])
def api_toggle_list(list_id):
    price_list = PriceList.query.get_or_404(list_id)

    if price_list.type != 'promotion':
        return jsonify({'error': 'Only promotions can be toggled. Markdowns are permanent.'}), 400

    price_list.active = not price_list.active
    db.session.commit()

    return jsonify({
        'success': True,
        'active': price_list.active,
        'list': price_list.to_dict()
    })


@app.route('/api/lists/<int:list_id>', methods=['DELETE'])
def api_delete_list(list_id):
    price_list = PriceList.query.get_or_404(list_id)
    db.session.delete(price_list)
    db.session.commit()
    return jsonify({'success': True, 'message': f'Deleted list "{price_list.name}"'})


# ─── API: Stats & Export ────────────────────────────────────────────────────

@app.route('/api/stats', methods=['GET'])
def api_stats():
    total_products = Product.query.count()
    mapped_products = Product.query.filter(Product.sku.isnot(None)).count()
    active_lists = PriceList.query.filter_by(active=True).count()
    total_lists = PriceList.query.count()
    recent_scans = ScanLog.query.order_by(ScanLog.scanned_at.desc()).limit(100).count()
    total_scans = ScanLog.query.count()

    departments = db.session.query(
        Product.department, db.func.count(Product.id)
    ).filter(Product.department.isnot(None)).group_by(Product.department).all()

    return jsonify({
        'total_products': total_products,
        'mapped_products': mapped_products,
        'unmapped_products': total_products - mapped_products,
        'active_lists': active_lists,
        'total_lists': total_lists,
        'recent_scans': recent_scans,
        'total_scans': total_scans,
        'departments': {dept: count for dept, count in departments}
    })


@app.route('/api/export/csv', methods=['GET'])
def api_export_csv():
    products = Product.query.order_by(Product.barcode).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['barcode', 'sku', 'description', 'department', 'current_price', 'last_updated'])

    for p in products:
        writer.writerow([
            p.barcode,
            p.sku or '',
            p.description or '',
            p.department or '',
            p.current_price or '',
            p.last_updated.isoformat() if p.last_updated else ''
        ])

    output.seek(0)
    response = make_response(output.getvalue())
    response.headers['Content-Type'] = 'text/csv'
    response.headers['Content-Disposition'] = 'attachment; filename=products_export.csv'
    return response


# ─── Static files / PWA ─────────────────────────────────────────────────────

@app.route('/manifest.json')
def serve_manifest():
    return app.send_static_file('manifest.json')


@app.route('/sw.js')
def serve_sw():
    response = make_response(app.send_static_file('sw.js'))
    response.headers['Content-Type'] = 'application/javascript'
    response.headers['Cache-Control'] = 'no-cache'
    return response


# ─── Init DB ────────────────────────────────────────────────────────────────

@app.cli.command('init-db')
def init_db():
    """Initialize the database."""
    db.create_all()
    print('Database tables created.')


# ─── Main ───────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    print('Starting Price Checker on http://localhost:5010')
    app.run(host='0.0.0.0', port=5010, debug=False)
