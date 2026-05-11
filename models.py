"""Database models for Price Checker app."""
import csv
import io
from datetime import datetime, date
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func

db = SQLAlchemy()


class Product(db.Model):
    __tablename__ = 'products'

    id = db.Column(db.Integer, primary_key=True)
    barcode = db.Column(db.String(15), unique=True, nullable=False, index=True)
    sku = db.Column(db.String(10), unique=True, nullable=True, index=True)
    description = db.Column(db.String(200), nullable=True)
    department = db.Column(db.String(50), nullable=True)
    current_price = db.Column(db.Float, nullable=True)
    last_updated = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'barcode': self.barcode,
            'sku': self.sku,
            'description': self.description,
            'department': self.department,
            'current_price': self.current_price,
            'last_updated': self.last_updated.isoformat() if self.last_updated else None
        }


class PriceList(db.Model):
    __tablename__ = 'price_lists'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    type = db.Column(db.String(20), nullable=False)  # 'markdown' or 'promotion'
    effective_date = db.Column(db.Date, nullable=True)
    end_date = db.Column(db.Date, nullable=True)
    active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    items = db.relationship('PriceListItem', backref='price_list', lazy='dynamic', cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'type': self.type,
            'effective_date': self.effective_date.isoformat() if self.effective_date else None,
            'end_date': self.end_date.isoformat() if self.end_date else None,
            'active': self.active,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'item_count': self.items.count()
        }


class PriceListItem(db.Model):
    __tablename__ = 'price_list_items'

    id = db.Column(db.Integer, primary_key=True)
    list_id = db.Column(db.Integer, db.ForeignKey('price_lists.id'), nullable=False)
    sku = db.Column(db.String(10), nullable=False, index=True)
    original_price = db.Column(db.Float, nullable=True)
    sale_price = db.Column(db.Float, nullable=False)
    discount_pct = db.Column(db.Float, nullable=True)

    def to_dict(self):
        return {
            'id': self.id,
            'list_id': self.list_id,
            'sku': self.sku,
            'original_price': self.original_price,
            'sale_price': self.sale_price,
            'discount_pct': self.discount_pct
        }


class ScanLog(db.Model):
    __tablename__ = 'scan_logs'

    id = db.Column(db.Integer, primary_key=True)
    barcode = db.Column(db.String(15), nullable=False)
    found = db.Column(db.Boolean, default=False)
    scanned_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'barcode': self.barcode,
            'found': self.found,
            'scanned_at': self.scanned_at.isoformat() if self.scanned_at else None
        }


def lookup_barcode(barcode):
    """Look up a product by barcode, return product + active price info."""
    product = Product.query.filter_by(barcode=barcode).first()
    if not product:
        return None, None

    active_prices = check_active_prices(product.sku)
    return product, active_prices


def lookup_sku(sku):
    """Look up a product by SKU."""
    return Product.query.filter_by(sku=sku).first()


def check_active_prices(sku):
    """Check all active price lists for a given SKU.
    Returns list of (price_list, price_list_item) tuples."""
    if not sku:
        return []

    today = date.today()
    results = []

    # Markdowns (permanent, no end date)
    markdown_lists = PriceList.query.filter_by(type='markdown', active=True).all()
    for pl in markdown_lists:
        if pl.effective_date and pl.effective_date > today:
            continue
        item = PriceListItem.query.filter_by(list_id=pl.id, sku=sku).first()
        if item:
            results.append((pl, item))

    # Promotions (temporary, with end dates, must be active and within range)
    promo_lists = PriceList.query.filter_by(type='promotion', active=True).all()
    for pl in promo_lists:
        if pl.effective_date and pl.effective_date > today:
            continue
        if pl.end_date and pl.end_date < today:
            continue
        item = PriceListItem.query.filter_by(list_id=pl.id, sku=sku).first()
        if item:
            results.append((pl, item))

    return results


def import_csv_stream(stream, has_header=True, barcode_col=0, sku_col=1, desc_col=2, delim=','):
    """Import products from a CSV stream. Returns (imported, skipped, errors)."""
    imported = 0
    skipped = 0
    errors = []

    reader = csv.reader(io.StringIO(stream.read().decode('utf-8')), delimiter=delim)

    for row_idx, row in enumerate(reader):
        if not row or (row_idx == 0 and has_header):
            continue

        try:
            barcode = row[barcode_col].strip()
            sku = row[sku_col].strip() if len(row) > sku_col else None
            description = row[desc_col].strip() if len(row) > desc_col and desc_col is not None else None

            if not barcode:
                continue

            existing = Product.query.filter_by(barcode=barcode).first()
            if existing:
                if sku:
                    existing.sku = sku
                if description:
                    existing.description = description
                existing.last_updated = datetime.utcnow()
                skipped += 1
            else:
                product = Product(
                    barcode=barcode,
                    sku=sku,
                    description=description,
                    last_updated=datetime.utcnow()
                )
                db.session.add(product)
                imported += 1

        except Exception as e:
            errors.append(f"Row {row_idx + 1}: {str(e)}")

    db.session.commit()
    return imported, skipped, errors
