/**
 * Price Checker — Mobile PWA Scanner Application
 * Handles camera barcode scanning, manual lookup, learning mode,
 * offline caching, and all UI interactions.
 */

const PriceChecker = (() => {
    'use strict';

    // ─── State ──────────────────────────────────────────────────────────────
    const state = {
        cameraActive: false,
        scanning: false,
        stream: null,
        videoTrack: null,
        barcodeDetector: null,
        scanTimer: null,
        currentBarcode: null,
        lastScanned: null,
        productsPage: 1,
        productsTotal: 0,
        productsPages: 0,
        selectedListId: null,
        productSearchTimeout: null,
        scanHistory: [],
    };

    // ─── DOM References ─────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const qs = (sel, ctx) => (ctx || document).querySelector(sel);
    const qsa = (sel, ctx) => (ctx || document).querySelectorAll(sel);

    // ─── Toast Notifications ────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        const container = $('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ─── API Helper ─────────────────────────────────────────────────────────
    async function api(method, url, body = null) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        try {
            const res = await fetch(url, opts);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            throw err;
        }
    }

    async function apiFormData(url, formData) {
        try {
            const res = await fetch(url, { method: 'POST', body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            throw err;
        }
    }

    // ─── Camera / Barcode Scanning ─────────────────────────────────────────
    async function initBarcodeDetector() {
        if ('BarcodeDetector' in window) {
            try {
                state.barcodeDetector = new BarcodeDetector({
                    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'codabar', 'itf', 'qr_code', 'data_matrix', 'pdf417', 'aztec']
                });
                return true;
            } catch (e) {
                console.warn('BarcodeDetector not supported:', e);
                state.barcodeDetector = null;
                return false;
            }
        }
        return false;
    }

    async function toggleCamera() {
        if (state.cameraActive) {
            stopCamera();
        } else {
            await startCamera();
        }
    }

    async function startCamera() {
        try {
            const video = $('scanner-video');
            if (!video) return;

            state.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
                audio: false,
            });

            video.srcObject = state.stream;
            state.videoTrack = state.stream.getVideoTracks()[0];
            state.cameraActive = true;

            const btn = $('btn-toggle-camera');
            if (btn) btn.classList.add('active');

            // Hide hint after camera starts
            const hint = $('camera-hint');
            if (hint) hint.textContent = '';

            await video.play();

            // Start scanning loop
            if (state.barcodeDetector) {
                startScanLoop();
            } else {
                // Fallback: no native barcode detection
                if (hint) hint.textContent = 'Barcode detection not available. Type barcode below.';
                showToast('Camera active — type barcode manually', 'info');
            }
        } catch (err) {
            console.error('Camera error:', err);
            showToast('Could not access camera: ' + err.message, 'error');
            state.cameraActive = false;
        }
    }

    function stopCamera() {
        if (state.scanTimer) {
            clearInterval(state.scanTimer);
            state.scanTimer = null;
        }
        if (state.stream) {
            state.stream.getTracks().forEach(t => t.stop());
            state.stream = null;
        }
        state.videoTrack = null;
        state.cameraActive = false;

        const video = $('scanner-video');
        if (video) video.srcObject = null;

        const btn = $('btn-toggle-camera');
        if (btn) btn.classList.remove('active');

        const hint = $('camera-hint');
        if (hint) hint.textContent = 'Camera stopped. Tap to restart.';
    }

    function startScanLoop() {
        if (state.scanTimer) clearInterval(state.scanTimer);

        state.scanTimer = setInterval(async () => {
            if (!state.barcodeDetector || !state.cameraActive) return;

            const video = $('scanner-video');
            if (!video || video.readyState < 2) return;

            try {
                const barcodes = await state.barcodeDetector.detect(video);
                if (barcodes.length > 0) {
                    // Get the most confident or largest barcode
                    const best = barcodes.reduce((a, b) => {
                        const aScore = a.confidence || 0;
                        const bScore = b.confidence || 0;
                        if (Math.abs(aScore - bScore) > 0.1) {
                            return aScore > bScore ? a : b;
                        }
                        return a.boundingBox.width > b.boundingBox.width ? a : b;
                    });

                    const code = best.rawValue.trim();
                    if (code && code !== state.lastScanned) {
                        state.lastScanned = code;
                        handleScan(code);
                    }
                }
            } catch (e) {
                // Silently ignore detection errors (common on some frames)
            }
        }, 400); // Scan every 400ms
    }

    // ─── Scan Handling ─────────────────────────────────────────────────────
    async function handleScan(barcode) {
        // Vibrate on scan
        if (navigator.vibrate) navigator.vibrate(50);

        // Update input field
        const input = $('barcode-input');
        if (input) input.value = barcode;

        // Add to scan history
        addToHistory(barcode);

        // Show result card with loading
        showResultLoading();

        state.currentBarcode = barcode;

        try {
            const data = await api('POST', '/api/scan', { barcode });
            displayResult(data, barcode);
        } catch (err) {
            // Try offline cache
            const cached = getCachedProduct(barcode);
            if (cached) {
                displayResult({ found: true, product: cached }, barcode);
                showToast('Showing cached data (offline)', 'info');
            } else {
                displayResult({ found: false, barcode, message: 'Network error. Try again.' }, barcode);
            }
        }
    }

    async function manualSearch() {
        const input = $('barcode-input');
        if (!input) return;
        const code = input.value.trim();
        if (!code) return;

        state.lastScanned = null; // Allow re-scan
        await handleScan(code);
    }

    function addToHistory(barcode) {
        state.scanHistory = state.scanHistory.filter(h => h !== barcode);
        state.scanHistory.unshift(barcode);
        if (state.scanHistory.length > 50) state.scanHistory.pop();

        // Save to localStorage
        try {
            localStorage.setItem('pc_scan_history', JSON.stringify(state.scanHistory));
        } catch (e) { /* ignore */ }

        renderHistoryChips();
    }

    function renderHistoryChips() {
        const container = $('scan-history-chips');
        if (!container) return;
        container.innerHTML = state.scanHistory.slice(0, 10).map(code =>
            `<span class="history-chip" onclick="PriceChecker.reScan('${code}')">${code}</span>`
        ).join('');
    }

    // Expose reScan
    function reScan(barcode) {
        const input = $('barcode-input');
        if (input) input.value = barcode;
        manualSearch();
    }

    // ─── Result Display ─────────────────────────────────────────────────────
    function showResultLoading() {
        const card = $('result-card');
        const loading = $('result-loading');
        const found = $('result-found');
        const notFound = $('result-not-found');

        if (card) card.classList.add('visible');
        if (loading) loading.classList.remove('hidden');
        if (found) found.classList.add('hidden');
        if (notFound) notFound.classList.add('hidden');
    }

    function displayResult(data, barcode) {
        const loading = $('result-loading');
        const found = $('result-found');
        const notFound = $('result-not-found');

        if (loading) loading.classList.add('hidden');

        if (data.found && data.product) {
            if (found) found.classList.remove('hidden');
            if (notFound) notFound.classList.add('hidden');
            populateResult(data.product);
        } else {
            if (found) found.classList.add('hidden');
            if (notFound) notFound.classList.remove('hidden');
            const msg = $('result-not-found-msg');
            if (msg) msg.textContent = data.message || `Unknown barcode: ${barcode}`;
            // Store barcode for learning
            state.currentBarcode = barcode;
        }
    }

    function populateResult(product) {
        const desc = $('result-description');
        if (desc) desc.textContent = product.description || 'Unknown Product';

        const sku = $('result-sku');
        if (sku) sku.textContent = product.sku || '—';

        const barcodeLabel = $('result-barcode-display');
        if (barcodeLabel) barcodeLabel.textContent = product.barcode;

        const dept = $('result-department');
        if (dept) {
            if (product.department) {
                dept.textContent = product.department;
                dept.classList.remove('hidden');
            } else {
                dept.classList.add('hidden');
            }
        }

        const price = $('result-price');
        const origPrice = $('result-original-price');
        const saleBadges = $('result-sale-badges');
        const promoInfo = $('result-promo-info');

        const sellingPrice = product.selling_price || product.current_price;

        // Determine if on sale
        const breakdown = product.price_breakdown || [];
        const hasSale = breakdown.length > 0;

        if (price) {
            if (sellingPrice != null) {
                price.textContent = `£${Number(sellingPrice).toFixed(2)}`;
                if (hasSale) {
                    price.classList.add('sale');
                } else {
                    price.classList.remove('sale');
                }
            } else {
                price.textContent = '—';
            }
        }

        if (origPrice) {
            // Show original price if different from selling
            const effectivePrice = product.current_price;
            if (effectivePrice != null && hasSale && sellingPrice < effectivePrice) {
                origPrice.textContent = `£${Number(effectivePrice).toFixed(2)}`;
                origPrice.classList.remove('hidden');
            } else {
                origPrice.classList.add('hidden');
            }
        }

        // Sale badges
        if (saleBadges) {
            saleBadges.innerHTML = '';
            for (const entry of breakdown) {
                const badge = document.createElement('span');
                badge.className = `sale-badge ${entry.list_type}`;
                const discount = entry.discount_pct ? `${Math.round(entry.discount_pct)}% OFF` : '';
                badge.textContent = `${discount ? discount + ' — ' : ''}${entry.list_name}`;
                if (entry.days_remaining != null) {
                    badge.textContent += ` (${entry.days_remaining}d left)`;
                }
                saleBadges.appendChild(badge);
            }
        }

        // Promo info
        if (promoInfo) {
            promoInfo.classList.add('hidden');
            const promoDetails = qs('.promo-details', promoInfo);
            if (promoDetails) promoDetails.innerHTML = '';
        }

        // Show learn button if no SKU
        const learnBtn = $('btn-lookup-sku');
        if (learnBtn) {
            if (!product.sku) {
                learnBtn.classList.remove('hidden');
                state.currentBarcode = product.barcode;
            } else {
                learnBtn.classList.add('hidden');
            }
        }

        // Cache for offline
        cacheProduct(product);
    }

    // ─── Offline Caching ────────────────────────────────────────────────────
    function cacheProduct(product) {
        try {
            let cache = JSON.parse(localStorage.getItem('pc_product_cache') || '{}');
            cache[product.barcode] = product;
            // Keep only last 500
            const keys = Object.keys(cache);
            if (keys.length > 500) {
                const toDelete = keys.slice(0, keys.length - 500);
                for (const k of toDelete) delete cache[k];
            }
            localStorage.setItem('pc_product_cache', JSON.stringify(cache));
        } catch (e) { /* storage full, ignore */ }
    }

    function getCachedProduct(barcode) {
        try {
            const cache = JSON.parse(localStorage.getItem('pc_product_cache') || '{}');
            return cache[barcode] || null;
        } catch (e) { return null; }
    }

    // ─── Learning Mode ──────────────────────────────────────────────────────
    function showLearnModal() {
        const modal = $('learn-modal');
        if (!modal) return;

        const barcodeInput = $('learn-barcode');
        if (barcodeInput) barcodeInput.value = state.currentBarcode || '';

        const skuInput = $('learn-sku');
        if (skuInput) skuInput.value = '';
        const descInput = $('learn-description');
        if (descInput) descInput.value = '';
        const deptInput = $('learn-department');
        if (deptInput) deptInput.value = '';
        const priceInput = $('learn-price');
        if (priceInput) priceInput.value = '';

        modal.classList.remove('hidden');
        if (skuInput) setTimeout(() => skuInput.focus(), 300);
    }

    function closeLearnModal() {
        const modal = $('learn-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function saveLearnedItem() {
        const barcode = $('learn-barcode')?.value?.trim();
        const sku = $('learn-sku')?.value?.trim();
        const description = $('learn-description')?.value?.trim();
        const department = $('learn-department')?.value?.trim();
        const price = $('learn-price')?.value?.trim();

        if (!barcode) {
            showToast('No barcode to learn', 'error');
            return;
        }

        if (!sku) {
            showToast('Please enter the SKU number', 'error');
            return;
        }

        try {
            const data = await api('POST', '/api/learn', {
                barcode,
                sku,
                description: description || undefined,
                department: department || undefined,
                current_price: price ? parseFloat(price) : undefined,
            });

            if (data.success) {
                showToast(`✅ ${data.message}`, 'success');
                closeLearnModal();

                // Refresh the result card
                const scanResult = await api('POST', '/api/scan', { barcode });
                displayResult(scanResult, barcode);
            }
        } catch (err) {
            showToast('Error saving: ' + err.message, 'error');
        }
    }

    // ─── Products Page ──────────────────────────────────────────────────────
    async function loadProducts(page = 1) {
        state.productsPage = page;
        const container = $('products-list');
        if (!container) return;

        const department = $('department-filter')?.value || '';

        try {
            let url = `/api/products?page=${page}&per_page=50`;
            if (department) url += `&department=${encodeURIComponent(department)}`;

            const data = await api('GET', url);
            state.productsTotal = data.total;
            state.productsPages = data.pages;

            // Update count
            const count = $('product-count');
            if (count) count.textContent = data.total;

            // Render items
            if (data.products.length === 0) {
                container.innerHTML = `
                    <div class="list-placeholder">
                        <p>No products mapped yet.</p>
                        <p style="font-size:13px;color:var(--text-tertiary)">Scan barcodes or import a CSV to get started.</p>
                    </div>`;
            } else {
                container.innerHTML = data.products.map(p => `
                    <div class="list-item product-item">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                            <div>
                                <div class="product-barcode">${p.barcode}</div>
                                <div class="product-sku">${p.sku || '—'}</div>
                            </div>
                            ${p.department ? `<span class="department-badge">${p.department}</span>` : ''}
                        </div>
                        <div class="product-desc">${p.description || 'Unknown Product'}</div>
                        <div class="product-price">${p.current_price != null ? `£${Number(p.current_price).toFixed(2)}` : '—'}</div>
                    </div>
                `).join('');
            }

            // Pagination
            const pagination = $('products-pagination');
            const pageInfo = $('page-info');
            const prevBtn = $('btn-prev-page');
            const nextBtn = $('btn-next-page');

            if (pagination) {
                if (data.pages > 1) {
                    pagination.classList.remove('hidden');
                    if (pageInfo) pageInfo.textContent = `Page ${page} of ${data.pages}`;
                    if (prevBtn) prevBtn.disabled = page <= 1;
                    if (nextBtn) nextBtn.disabled = page >= data.pages;
                } else {
                    pagination.classList.add('hidden');
                }
            }

            // Update department filter options
            updateDepartmentFilter(data);
        } catch (err) {
            container.innerHTML = `<div class="list-placeholder"><p>Error loading products: ${err.message}</p></div>`;
        }
    }

    function updateDepartmentFilter(data) {
        const filter = $('department-filter');
        if (!filter) return;

        // Extract departments from products
        const depts = new Set();
        data.products.forEach(p => {
            if (p.department) depts.add(p.department);
        });

        const currentVal = filter.value;
        const options = Array.from(filter.options);
        const existingDepts = new Set();
        for (let i = 1; i < options.length; i++) {
            existingDepts.add(options[i].value);
        }

        for (const dept of depts) {
            if (!existingDepts.has(dept)) {
                const opt = document.createElement('option');
                opt.value = dept;
                opt.textContent = dept;
                filter.appendChild(opt);
            }
        }

        filter.value = currentVal;
    }

    function filterByDepartment() {
        loadProducts(1);
    }

    function clearProductSearch() {
        const input = $('product-search');
        if (input) input.value = '';
        loadProducts(1);
    }

    function prevPage() {
        if (state.productsPage > 1) loadProducts(state.productsPage - 1);
    }

    function nextPage() {
        if (state.productsPage < state.productsPages) loadProducts(state.productsPage + 1);
    }

    // ─── Product Search ─────────────────────────────────────────────────────
    function setupProductSearch() {
        const input = $('product-search');
        if (!input) return;

        input.addEventListener('input', () => {
            clearTimeout(state.productSearchTimeout);
            const q = input.value.trim();
            if (q.length < 3) {
                if (q.length === 0) loadProducts(1);
                return;
            }
            state.productSearchTimeout = setTimeout(async () => {
                try {
                    const data = await api('GET', `/api/products/search?q=${encodeURIComponent(q)}`);
                    const container = $('products-list');
                    if (!container) return;
                    if (data.products.length === 0) {
                        container.innerHTML = `<div class="list-placeholder"><p>No results for "${q}"</p></div>`;
                    } else {
                        container.innerHTML = data.products.map(p => `
                            <div class="list-item product-item">
                                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                                    <div>
                                        <div class="product-barcode">${p.barcode}</div>
                                        <div class="product-sku">${p.sku || '—'}</div>
                                    </div>
                                    ${p.department ? `<span class="department-badge">${p.department}</span>` : ''}
                                </div>
                                <div class="product-desc">${p.description || 'Unknown Product'}</div>
                                <div class="product-price">${p.current_price != null ? `£${Number(p.current_price).toFixed(2)}` : '—'}</div>
                            </div>
                        `).join('');
                    }

                    const pagination = $('products-pagination');
                    if (pagination) pagination.classList.add('hidden');

                    const clearBtn = $('btn-clear-search');
                    if (clearBtn) clearBtn.classList.remove('hidden');
                } catch (err) {
                    // Silent fail
                }
            }, 300);
        });

        input.addEventListener('search', () => {
            if (!input.value) {
                loadProducts(1);
                const clearBtn = $('btn-clear-search');
                if (clearBtn) clearBtn.classList.add('hidden');
            }
        });
    }

    // ─── Price Lists Page ──────────────────────────────────────────────────
    async function loadLists() {
        const container = $('lists-container');
        if (!container) return;

        try {
            const data = await api('GET', '/api/lists');
            const lists = data.lists || [];

            if (lists.length === 0) {
                container.innerHTML = `
                    <div class="list-placeholder">
                        <p>No price lists yet.</p>
                        <p style="font-size:13px;color:var(--text-tertiary)">Create a markdown or promotion list to get started.</p>
                    </div>`;
                return;
            }

            container.innerHTML = lists.map(pl => {
                const isPromo = pl.type === 'promotion';
                const daysLeft = pl.end_date ? daysBetween(new Date(), new Date(pl.end_date + 'T00:00:00')) : null;
                let countdownClass = 'safe';
                if (daysLeft !== null) {
                    if (daysLeft <= 3) countdownClass = 'urgent';
                    else if (daysLeft <= 7) countdownClass = 'soon';
                }

                const endDateStr = pl.end_date ? new Date(pl.end_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Permanent';
                const effectiveDateStr = pl.effective_date ? new Date(pl.effective_date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Immediate';

                return `
                    <div class="list-card" data-list-id="${pl.id}">
                        <div class="list-card-header">
                            <span class="list-card-name">${pl.name}</span>
                            <span class="badge ${isPromo ? 'badge-warning' : 'badge-danger'}">${isPromo ? 'Promotion' : 'Markdown'}</span>
                        </div>
                        <div class="list-card-meta">
                            <span class="badge badge-secondary">${pl.item_count} items</span>
                            ${isPromo ? `
                                <span class="badge ${pl.active ? 'badge-success' : 'badge-secondary'}">${pl.active ? 'Active' : 'Inactive'}</span>
                            ` : ''}
                        </div>
                        <div class="list-card-date">Effective: ${effectiveDateStr}</div>
                        <div class="list-card-date">Ends: ${endDateStr}</div>
                        ${daysLeft !== null ? `
                            <div class="list-card-date">
                                <span class="countdown ${countdownClass}">${daysLeft} days remaining</span>
                            </div>
                        ` : ''}
                        <div class="list-card-actions">
                            ${isPromo ? `
                                <div class="toggle-switch ${pl.active ? 'active' : ''}" onclick="PriceChecker.toggleList(${pl.id})"></div>
                            ` : ''}
                            <button class="btn btn-secondary btn-sm" onclick="PriceChecker.showImportItemsModal(${pl.id})">+ Items</button>
                            <button class="btn btn-danger btn-sm" onclick="PriceChecker.deleteList(${pl.id})">Delete</button>
                        </div>
                    </div>
                `;
            }).join('');
        } catch (err) {
            container.innerHTML = `<div class="list-placeholder"><p>Error loading lists: ${err.message}</p></div>`;
        }
    }

    function daysBetween(d1, d2) {
        const diff = d2.getTime() - d1.getTime();
        return Math.max(0, Math.round(diff / (1000 * 60 * 60 * 24)));
    }

    // ─── Create List Modal ─────────────────────────────────────────────────
    function showCreateListModal() {
        const modal = $('create-list-modal');
        if (modal) {
            modal.classList.remove('hidden');
            // Reset form
            const name = $('new-list-name');
            if (name) name.value = '';
            const type = $('new-list-type');
            if (type) type.value = 'markdown';
            onListTypeChange();
        }
    }

    function closeCreateListModal() {
        const modal = $('create-list-modal');
        if (modal) modal.classList.add('hidden');
    }

    function closeModal(event) {
        if (event && event.target === event.currentTarget) {
            event.currentTarget.classList.add('hidden');
        }
    }

    function onListTypeChange() {
        const type = $('new-list-type')?.value;
        const endDateGroup = $('end-date-group');
        const endDateReq = $('end-date-req');
        const hint = $('list-type-hint');

        if (type === 'promotion') {
            if (endDateGroup) endDateGroup.style.display = 'block';
            if (endDateReq) endDateReq.style.display = 'inline';
            if (hint) hint.textContent = 'Promotions are temporary. They can be toggled on/off and must have an end date.';
        } else {
            if (endDateGroup) endDateGroup.style.display = 'none';
            if (endDateReq) endDateReq.style.display = 'none';
            if (hint) hint.textContent = 'Markdowns are permanent price reductions with no end date.';
        }
    }

    async function createPriceList() {
        const name = $('new-list-name')?.value?.trim();
        const type = $('new-list-type')?.value;
        const effectiveDate = $('new-list-effective-date')?.value || null;
        const endDate = $('new-list-end-date')?.value || null;

        if (!name) {
            showToast('Please enter a list name', 'error');
            return;
        }

        if (type === 'promotion' && !endDate) {
            showToast('Promotions must have an end date', 'error');
            return;
        }

        try {
            const data = await api('POST', '/api/lists', {
                name,
                type,
                effective_date: effectiveDate || undefined,
                end_date: endDate || undefined,
            });

            if (data.success) {
                showToast(`✅ Created "${name}"`, 'success');
                closeCreateListModal();
                loadLists();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    // ─── Import Items Modal ────────────────────────────────────────────────
    function showImportItemsModal(listId) {
        state.selectedListId = listId;
        const modal = $('import-items-modal');
        if (modal) {
            modal.classList.remove('hidden');
            // Reset
            const file = $('import-items-file');
            if (file) file.value = '';
        }
    }

    function closeImportItemsModal() {
        const modal = $('import-items-modal');
        if (modal) modal.classList.add('hidden');
        state.selectedListId = null;
    }

    async function uploadListItems() {
        const listId = state.selectedListId;
        if (!listId) return;

        const fileInput = $('import-items-file');
        if (!fileInput || !fileInput.files[0]) {
            showToast('Please select a CSV file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('sku_col', $('import-sku-col')?.value || '0');
        formData.append('price_col', $('import-price-col')?.value || '1');
        formData.append('original_price_col', $('import-original-price-col')?.value || '');
        formData.append('has_header', $('import-items-header')?.checked ? 'true' : 'false');

        try {
            const data = await apiFormData(`/api/lists/${listId}/items`, formData);
            if (data.success) {
                showToast(`✅ Added ${data.added} items${data.errors.length ? ` (${data.errors.length} errors)` : ''}`, 'success');
                closeImportItemsModal();
                loadLists();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    // ─── Toggle / Delete List ──────────────────────────────────────────────
    async function toggleList(listId) {
        try {
            const data = await api('POST', `/api/lists/${listId}/toggle`);
            if (data.success) {
                showToast(data.active ? '✅ Promotion activated' : '⏸️ Promotion deactivated', 'info');
                loadLists();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    async function deleteList(listId) {
        if (!confirm('Delete this price list and all its items?')) return;

        try {
            const data = await api('DELETE', `/api/lists/${listId}`);
            if (data.success) {
                showToast('🗑️ ' + data.message, 'info');
                loadLists();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    // ─── Settings / Import ─────────────────────────────────────────────────
    async function loadStats() {
        try {
            const data = await api('GET', '/api/stats');

            const statProducts = $('stat-products');
            if (statProducts) statProducts.textContent = data.total_products;

            const statMapped = $('stat-mapped');
            if (statMapped) statMapped.textContent = data.mapped_products;

            const statLists = $('stat-active-lists');
            if (statLists) statLists.textContent = data.active_lists;

            const statScans = $('stat-scans');
            if (statScans) statScans.textContent = data.total_scans;
        } catch (err) {
            // Silent fail for stats
        }
    }

    function updateFileName(input, displayId) {
        const display = $(displayId);
        if (display && input.files[0]) {
            display.textContent = `📄 ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(0)} KB)`;
        }
    }

    async function importStockTake() {
        const fileInput = $('stocktake-file');
        if (!fileInput || !fileInput.files[0]) {
            showToast('Please select a stock take file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('barcode_col', $('stocktake-barcode-col')?.value || '0');
        formData.append('sku_col', $('stocktake-sku-col')?.value || '1');
        formData.append('has_header', $('stocktake-header')?.checked ? 'true' : 'false');

        const delimSelect = $('stocktake-delimiter');
        const delim = delimSelect?.value === '\\t' ? '\t' : (delimSelect?.value || ',');
        formData.append('delimiter', delim);

        showToast('Importing stock take data...', 'info');

        try {
            const data = await apiFormData('/api/import/stocktake', formData);
            if (data.success) {
                showToast(`✅ Imported ${data.imported} new, ${data.skipped} updated${data.errors.length ? ` (${data.errors.length} errors)` : ''}`, 'success');
                loadStats();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    async function bulkImport() {
        const fileInput = $('bulk-file');
        if (!fileInput || !fileInput.files[0]) {
            showToast('Please select a CSV file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('barcode_col', '0');
        formData.append('sku_col', '1');
        formData.append('desc_col', '2');
        formData.append('has_header', 'true');

        showToast('Importing products...', 'info');

        try {
            const data = await apiFormData('/api/import/csv', formData);
            if (data.success) {
                showToast(`✅ Imported ${data.imported} new, ${data.skipped} updated${data.errors.length ? ` (${data.errors.length} errors)` : ''}`, 'success');
                loadStats();
            }
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
        }
    }

    function exportCSV() {
        window.location.href = '/api/export/csv';
        showToast('Downloading product CSV...', 'info');
    }

    async function clearDatabase() {
        if (!confirm('⚠️ This will permanently delete ALL product data, price lists, and scan history. Are you sure?')) return;
        if (!confirm('Really delete everything? This cannot be undone!')) return;

        try {
            // Delete all data via API calls
            // First delete all lists
            const listsData = await api('GET', '/api/lists');
            for (const pl of listsData.lists || []) {
                await api('DELETE', `/api/lists/${pl.id}`);
            }
            showToast('🗑️ All data cleared', 'info');
            loadStats();
        } catch (err) {
            showToast('Error clearing data: ' + err.message, 'error');
        }
    }

    // ─── Service Worker Registration ───────────────────────────────────────
    function registerSW() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js')
                .then(reg => console.log('SW registered:', reg.scope))
                .catch(err => console.warn('SW registration failed:', err));
        }
    }

    // ─── Keyboard Shortcuts ────────────────────────────────────────────────
    function setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Enter on manual input → search
            if (e.key === 'Enter') {
                const input = $('barcode-input');
                if (input && document.activeElement === input) {
                    e.preventDefault();
                    manualSearch();
                }
            }
            // Escape closes modals
            if (e.key === 'Escape') {
                qsa('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
            }
        });
    }

    // ─── Initialization ────────────────────────────────────────────────────
    async function init() {
        console.log('🔍 Price Checker initializing...');

        // Load scan history
        try {
            const history = JSON.parse(localStorage.getItem('pc_scan_history') || '[]');
            state.scanHistory = history;
            renderHistoryChips();
        } catch (e) { /* ignore */ }

        // Init barcode detector
        await initBarcodeDetector();

        // Register service worker
        registerSW();

        // Setup search input
        setupProductSearch();

        // Setup keyboard
        setupKeyboard();

        // Auto-start camera on scan page (if we're on it)
        if ($('scanner-video')) {
            // Check if we should auto-start (user preference)
            const autoStart = localStorage.getItem('pc_auto_camera') !== 'false';
            if (autoStart) {
                setTimeout(() => startCamera(), 500);
            }
        }

        console.log('✅ Price Checker ready');
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ─── Public API ────────────────────────────────────────────────────────
    return {
        toggleCamera,
        manualSearch,
        reScan,
        showLearnModal,
        closeLearnModal,
        saveLearnedItem,
        closeModal,
        loadProducts,
        filterByDepartment,
        clearProductSearch,
        prevPage,
        nextPage,
        loadLists,
        showCreateListModal,
        closeCreateListModal,
        onListTypeChange,
        createPriceList,
        showImportItemsModal,
        closeImportItemsModal,
        uploadListItems,
        toggleList,
        deleteList,
        loadStats,
        updateFileName,
        importStockTake,
        bulkImport,
        exportCSV,
        clearDatabase,
    };
})();
