const biDimensions = {
    month: "Tháng/năm", customer: "Khách hàng", staff: "Nhân viên kinh doanh",
    business: "Nhóm kinh doanh", category: "Nhóm vật tư", category1: "Nhóm vật tư 1", ptn: "Sản phẩm PTN"
};
const biMeasures = { revenue: "Doanh thu thuần", quantity: "Sản lượng sau trả lại", orders: "Số đơn hàng" };
const biTimeGrains = { day: "Ngày", month: "Tháng", quarter: "Quý", year: "Năm" };
const biMaterialFilterDimensions = ["ptn", "category", "category1"];
let biBoard = null;
let biRows = [];
let biMaterials = {};
let biStockRows = null;
let biStockUpdatedAt = "";
let biStockPromise = null;
let biStockError = "";
let biOwner = null;
let biGeneration = 0;
let biBusy = false;
let biDirty = false;
let biEditing = null;
let biCharts = [];
let biFilterMatches = [];
let biFilterActive = -1;
let biMaterialFilterOptionCache = {};

function biSetStatus(message) {
    document.getElementById("biStatus").textContent = message;
}

function biSetBusy(busy) {
    biBusy = busy;
    document.querySelectorAll("#screen-bi button, #screen-bi input").forEach(element => { element.disabled = busy; });
}

function biReset() {
    biGeneration++;
    biCharts.forEach(chart => chart.destroy());
    biCharts = [];
    biBoard = null;
    biRows = [];
    biMaterials = {};
    biStockRows = null;
    biStockUpdatedAt = "";
    biStockPromise = null;
    biStockError = "";
    biMaterialFilterOptionCache = {};
    biOwner = null;
    biDirty = false;
    biSetBusy(false);
    const stockButton = document.getElementById("biRefreshStock");
    stockButton.disabled = false;
    stockButton.classList.remove("bg-blue-700");
    stockButton.classList.add("bg-blue-600");
    stockButton.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i><span>Tải tồn kho</span>';
    document.getElementById("biWidgets").innerHTML = "";
    document.getElementById("biEditor").classList.add("hidden");
    document.getElementById("biFrom").value = "";
    document.getElementById("biTo").value = "";
    biSetStatus("Chưa tải bảng.");
}

function biHasUnsavedChanges() {
    return !!biBoard && (biDirty || document.getElementById("biFrom").value !== biBoard.from ||
        document.getElementById("biTo").value !== biBoard.to || !document.getElementById("biEditor").classList.contains("hidden"));
}

window.addEventListener("beforeunload", event => {
    if (biHasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; }
});

async function biOpen() {
    if (!currentUser || !getSessionToken()) return openAuthModal();
    if (biBoard && biOwner === currentUser.useremail) return;
    await biLoadBoard();
}

async function biLoadBoard() {
    if (biBusy) return;
    if (biHasUnsavedChanges() && !confirm("Tải lại sẽ bỏ các thay đổi chưa lưu. Tiếp tục?")) return;
    const generation = ++biGeneration;
    const token = getSessionToken();
    biOwner = currentUser.useremail;
    biCharts.forEach(chart => chart.destroy());
    biCharts = [];
    biRows = [];
    biStockRows = null;
    biStockUpdatedAt = "";
    biStockPromise = null;
    biStockError = "";
    biMaterialFilterOptionCache = {};
    biBoard = null;
    document.getElementById("biWidgets").innerHTML = "";
    document.getElementById("biEditor").classList.add("hidden");
    biSetBusy(true);
    biSetStatus("Đang tải bảng phân tích...");
    try {
        const [board, materials] = await Promise.all([
            api("getBiBoard", token), api("getData", token, "danh_muc_vat_tu")
        ]);
        if (generation !== biGeneration) return;
        if (!board || !Number.isInteger(board.revision) || !Array.isArray(board.widgets)) throw new Error("Bảng B.I trả về không hợp lệ.");
        if (!materials || materials.status !== "success" || !Array.isArray(materials.data)) throw new Error("Danh mục vật tư trả về không hợp lệ.");
        biMaterials = Object.fromEntries(materials.data.map(material => [material.ma_vt, material]));
        if (!board.from && !board.to && board.revision === 0) {
            board.from = getDateInput("fromDate");
            board.to = getDateInput("toDate");
        }
        biBoard = board;
        document.getElementById("biFrom").value = board.from;
        document.getElementById("biTo").value = board.to;
        biDirty = false;
        await biLoadRows(generation);
    } catch (error) {
        if (generation !== biGeneration) return;
        biBoard = null;
        biSetStatus("Không tải được bảng B.I. Hãy chọn Tải lại bảng.");
        reportDataError("Lỗi tải bảng B.I", error);
    } finally {
        if (generation === biGeneration) biSetBusy(false);
    }
}

async function biLoadRows(generation) {
    const from = document.getElementById("biFrom").value;
    const to = document.getElementById("biTo").value;
    if (!from || !to || from > to) throw new Error("Khoảng ngày B.I không hợp lệ.");
    biSetStatus("Đang tải dữ liệu bán hàng...");
    const rows = await loadPartitioned("ban_hang", from, to, false, true);
    if (generation !== biGeneration) return;
    biRows = rows;
    if (biBoard.from !== from || biBoard.to !== to) biDirty = true;
    biBoard.from = from;
    biBoard.to = to;
    biRender();
    biSetStatus(`${rows.length.toLocaleString("vi-VN")} dòng bán hàng; ${biDirty ? "có thay đổi chưa lưu." : "đã tải cấu hình."}`);
}

function biLoadStock() {
    if (biStockRows !== null || biStockPromise) return biStockPromise;
    const generation = biGeneration;
    biStockPromise = (async () => {
        try {
            const response = await api("getData", getSessionToken(), "ton_kho");
            if (generation !== biGeneration) return;
            if (!response || response.status !== "success" || !Array.isArray(response.data)) {
                throw new Error("Dữ liệu ton_kho.json trả về không hợp lệ.");
            }
            biSetStockData(response);
            biStockError = "";
            biRender();
        } catch (error) {
            if (generation !== biGeneration) return;
            biStockError = error && error.message ? error.message : String(error);
            biRender();
            biSetStatus(`Không tải được dữ liệu tồn kho: ${biStockError}`);
            reportDataError("Lỗi tải dữ liệu tồn kho", error);
        } finally {
            if (generation === biGeneration) biStockPromise = null;
        }
    })();
    return biStockPromise;
}

function biSetStockData(response) {
    if (!response || response.status !== "success" || !Array.isArray(response.data)) {
        throw new Error("Dữ liệu ton_kho.json trả về không hợp lệ.");
    }
    biStockRows = response.data.map((row, index) => {
        if (!row || typeof row.ma_vt !== "string" || typeof row.ma_ptn !== "string" || typeof row.dvt !== "string") {
            throw new Error(`Dòng tồn kho ${index + 1} không hợp lệ.`);
        }
        const quantity = Number(row.ton_cuoi);
        if (!Number.isFinite(quantity)) throw new Error(`Dòng tồn kho ${index + 1} không hợp lệ.`);
        return { ma_vt: row.ma_vt, ma_ptn: row.ma_ptn, dvt: row.dvt, ton_cuoi: quantity };
    });
    biStockUpdatedAt = String(response.updatedAt || "");
}

async function biRefreshStock() {
    if (!biBoard || biBusy) return;
    if (!isAdmin()) return reportDataError("Không đủ quyền", new Error("Chỉ admin mới được tải mới tồn kho từ SQL."));
    const generation = biGeneration;
    const button = document.getElementById("biRefreshStock");
    const originalLabel = button.innerHTML;
    const originalClass = button.className;
    biSetBusy(true);
    button.classList.remove("bg-blue-600");
    button.classList.add("bg-blue-700");
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Đang tải...</span>';
    biSetStatus("Đang tải tồn kho mới từ SQL...");
    try {
        if (biStockPromise) await biStockPromise;
        const result = await api("refreshStockData", getSessionToken());
        if (generation !== biGeneration) return;
        if (!result || result.ok !== true || !Number.isInteger(result.rowCount) || result.rowCount < 0) {
            throw new Error("SQL không xác nhận kết quả tải tồn kho hợp lệ.");
        }
        const response = await api("getData", getSessionToken(), "ton_kho");
        if (generation !== biGeneration) return;
        biSetStockData(response);
        biStockError = "";
        biRender();
        biSetStatus(`Đã tải mới ${Number(result.rowCount).toLocaleString("vi-VN")} dòng tồn kho từ SQL.`);
    } catch (error) {
        if (generation !== biGeneration) return;
        biSetStatus("Tải tồn kho thất bại; dữ liệu trước đó vẫn được giữ.");
        reportDataError("Lỗi tải tồn kho từ SQL", error);
    } finally {
        if (generation === biGeneration) {
            biSetBusy(false);
            button.disabled = false;
            button.innerHTML = originalLabel;
            button.className = originalClass;
        }
    }
}

async function biApplyDates() {
    if (!biBoard || biBusy) return;
    const generation = ++biGeneration;
    biSetBusy(true);
    try {
        await biLoadRows(generation);
    } catch (error) {
        if (generation !== biGeneration) return;
        document.getElementById("biFrom").value = biBoard.from;
        document.getElementById("biTo").value = biBoard.to;
        biSetStatus("Không tải được khoảng ngày mới; đang giữ dữ liệu khoảng ngày trước.");
        reportDataError("Lỗi tải dữ liệu B.I", error);
    } finally {
        if (generation === biGeneration) biSetBusy(false);
    }
}

async function biSaveBoard() {
    if (!biBoard || biBusy) return;
    if (document.getElementById("biFrom").value !== biBoard.from || document.getElementById("biTo").value !== biBoard.to) {
        biSetStatus("Hãy áp dụng khoảng ngày trước khi lưu.");
        return;
    }
    const generation = biGeneration;
    biSetBusy(true);
    biSetStatus("Đang lưu bảng...");
    try {
        const saved = await api("saveBiBoard", getSessionToken(), biBoard, biBoard.revision);
        if (generation !== biGeneration) return;
        biBoard = saved;
        biDirty = false;
        biSetStatus("Đã lưu bảng B.I cho tài khoản hiện tại.");
    } catch (error) {
        if (generation !== biGeneration) return;
        biSetStatus("Lưu thất bại; thay đổi vẫn chưa được lưu.");
        reportDataError("Lỗi lưu bảng B.I", error);
    } finally {
        if (generation === biGeneration) biSetBusy(false);
    }
}

function biDimension(row, dimension) {
    switch (dimension) {
        case "month": return [String(row.ngay_ct || "").slice(0, 7), String(row.ngay_ct || "").slice(0, 7)];
        case "customer": return [String(row.ma_kh || row.ten_kh || ""), `${row.ten_kh || "(Chưa có tên khách hàng)"}${row.ma_kh ? ` — ${row.ma_kh}` : ""}`];
        case "staff": return [String(row.ten_nvkd || row.ma_nhomkd || ""), String(row.ten_nvkd || row.ma_nhomkd || "(Chưa có nhân viên)")];
        case "business": { const code = businessGroupOf(row); return [code, businessGroupLabel(code)]; }
        case "category": { const m = biMaterials[row.ma_vt]; const label = m && (m.ten_nhvt || m.ma_nhvt) || "Chưa phân nhóm"; return [label, label, m && m.ma_nhvt || ""]; }
        case "category1": { const m = biMaterials[row.ma_vt]; const label = m && (m.ten_nhvt1 || m.ma_nhvt1) || "Chưa phân nhóm"; return [label, label, m && m.ma_nhvt1 || ""]; }
        case "ptn": { const code = ptnOf(row); const material = biMaterials[code]; return [code, `${material && material.ten_vt || "Không tìm thấy tên trong danh mục"} — ${code || "(Không có mã PTN)"}`]; }
        default: throw new Error("Chiều phân tích không hợp lệ.");
    }
}

function biPeriod(row, grain) {
    const date = String(row.ngay_ct || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
    if (grain === "day") return date;
    if (grain === "month") return date.slice(0, 7);
    if (grain === "year") return date.slice(0, 4);
    if (grain === "quarter") return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
    throw new Error("Chiều thời gian không hợp lệ.");
}

function biAggregate(rows, widget) {
    const groups = new Map();
    let invalid = 0;
    rows.forEach(row => {
        const [key, label, code = ""] = biDimension(row, widget.dimension);
        if (widget.filter && !searchableText(`${label} ${key} ${code}`).includes(searchableText(widget.filter))) return;
        const value = widget.measure === "quantity" ? row.sl_ban_sau_tra_lai : window.erpNetRevenue(row);
        const order = String(row.so_ct || "").trim();
        if (widget.measure === "orders" ? !order : value == null || String(value).trim() === "" || !Number.isFinite(Number(value))) {
            invalid++;
            return;
        }
        const period = widget.timeGrain ? biPeriod(row, widget.timeGrain) : "";
        if (widget.timeGrain && !period) { invalid++; return; }
        let group = groups.get(key);
        if (!group) {
            group = { key, label, value: 0, orders: new Set(), periods: new Map() };
            groups.set(key, group);
        }
        if (widget.measure === "orders") {
            group.orders.add(order);
        } else {
            group.value += Number(value);
        }
        if (period) {
            if (!group.periods.has(period)) group.periods.set(period, { value: 0, orders: new Set() });
            const cell = group.periods.get(period);
            if (widget.measure === "orders") cell.orders.add(order); else cell.value += Number(value);
        }
    });
    let result = [...groups.values()];
    if (widget.measure === "orders") result.forEach(group => {
        group.value = group.orders.size;
        group.periods.forEach(cell => { cell.value = cell.orders.size; });
    });
    result.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "vi"));
    if (widget.limit) result = result.slice(0, widget.limit);
    if (widget.dimension === "month") result.sort((a, b) => a.key.localeCompare(b.key));
    if (widget.measure === "quantity") result.forEach(group => {
        const material = biMaterials[group.key];
        group.unit = material && String(material.dvt || "").trim() || "Chưa có ĐVT PTN";
    });
    return { result, invalid };
}

function biRenderTime(content, result, widget) {
    const periods = [...new Set(result.flatMap(group => [...group.periods.keys()]))].sort();
    const stockTotals = biStockTotals(widget);
    if (widget.chart === "table") {
        const table = document.createElement("table");
        table.className = "w-full text-xs text-left";
        const head = document.createElement("thead");
        head.innerHTML = `<tr><th class="p-2">Thời gian</th><th class="p-2">Chiều phân tích</th><th class="p-2 text-right">Giá trị</th>${stockTotals.map(stock => `<th class="p-2 text-right whitespace-nowrap">${esc(biStockLabel(stock))}</th>`).join("")}</tr>`;
        table.appendChild(head);
        const body = document.createElement("tbody");
        for (const period of periods) for (const group of result) {
            const cell = group.periods.get(period);
            if (!cell) continue;
            const row = document.createElement("tr");
            row.className = "border-t";
            row.innerHTML = `<td class="p-2 whitespace-nowrap">${esc(period)}</td><td class="p-2">${esc(group.label)}</td><td class="p-2 text-right whitespace-nowrap">${esc(biValue({ value: cell.value, unit: group.unit }, widget.measure))}</td>${stockTotals.map(stock => `<td class="p-2 text-right whitespace-nowrap">${esc(`${biStockValue(stock)} ${stock.unit}`)}</td>`).join("")}`;
            body.appendChild(row);
        }
        table.appendChild(body);
        content.appendChild(table);
        return;
    }
    const colors = ["#2563eb", "#dc2626", "#059669", "#9333ea", "#d97706", "#0891b2", "#db2777", "#4d7c0f"];
    for (let groupOffset = 0; groupOffset < result.length; groupOffset += 30) {
        const groups = result.slice(groupOffset, groupOffset + 30);
        for (let offset = 0; offset < periods.length; offset += 60) {
            const part = periods.slice(offset, offset + 60);
            const wrap = document.createElement("div");
            wrap.className = "relative";
            wrap.style.width = `${Math.max(450, part.length * 55)}px`;
            wrap.style.height = "350px";
            const canvas = document.createElement("canvas");
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", widget.title);
            wrap.appendChild(canvas);
            content.appendChild(wrap);
            biCharts.push(new Chart(canvas.getContext("2d"), {
                type: widget.chart,
                data: { labels: part, datasets: [
                    ...groups.map((group, i) => ({
                        label: widget.measure === "quantity" ? `${group.label} (${group.unit})` : group.label,
                        data: part.map(period => group.periods.has(period) ? group.periods.get(period).value : null),
                        backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length], borderRadius: 4
                    })),
                    ...stockTotals.map((stock, i) => ({
                        type: "line", label: biStockLabel(stock), data: part.map(() => stock.value),
                        borderColor: ["#dc2626", "#d97706", "#7c3aed", "#0891b2"][i % 4],
                        borderDash: [6, 4], pointRadius: 0, fill: false
                    }))
                ] },
                options: { responsive: true, maintainAspectRatio: false, spanGaps: false,
                    scales: { x: { title: { display: true, text: biTimeGrains[widget.timeGrain] } } },
                    plugins: { tooltip: { callbacks: { label: item => {
                        if (item.datasetIndex >= groups.length) {
                            const stock = stockTotals[item.datasetIndex - groups.length];
                            return biStockLabel(stock);
                        }
                        const group = groups[item.datasetIndex];
                        return `${group.label}: ${biValue({ value: item.raw, unit: group.unit }, widget.measure)}`;
                    } } } } }
            }));
        }
    }
}

function biValue(group, measure) {
    if (measure === "revenue") return formatVND(group.value);
    const value = group.value.toLocaleString("vi-VN", { maximumFractionDigits: 3 });
    return measure === "quantity" ? `${value} ${group.unit}` : value;
}

function biStockLabel(stock) {
    const value = biStockValue(stock);
    return `Tồn kho: ${value} (${stock.unit})`;
}

function biStockValue(stock) {
    return stock.value.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function biStockTotals(widget) {
    if (!widget.stockBy || biStockRows === null) return [];
    const field = widget.stockBy === "sku" ? "ma_vt" : "ma_ptn";
    const filter = searchableText(widget.filter);
    const totals = new Map();
    biStockRows.forEach(row => {
        if (filter && !searchableText(row[field]).includes(filter)) return;
        const unit = String(row.dvt || "").trim() || "Chưa có ĐVT";
        totals.set(unit, (totals.get(unit) || 0) + row.ton_cuoi);
    });
    return [...totals.entries()].map(([unit, value]) => ({ unit, value })).sort((a, b) => a.unit.localeCompare(b.unit, "vi"));
}

function biStockStatus(widget) {
    if (!widget.stockBy) return "";
    if (biStockRows === null) {
        return biStockError
            ? `<p class="text-xs text-red-700 mt-1">Không tải được ton_kho.json: ${esc(biStockError)}</p>`
            : '<p class="text-xs text-slate-500 mt-1">Đang tải dữ liệu tồn kho...</p>';
    }
    if (!biStockTotals(widget).length) {
        return `<p class="text-xs text-amber-700 mt-1">Không có tồn kho theo ${widget.stockBy === "sku" ? "SKU" : "Mã PTN"} khớp với bộ lọc.</p>`;
    }
    const updatedAt = biStockUpdatedAt ? ` · cập nhật ${esc(biStockUpdatedAt)}` : "";
    return `<p class="text-xs text-slate-500 mt-1">Tồn kho theo ${widget.stockBy === "sku" ? "SKU" : "Mã PTN"}${updatedAt}.</p>`;
}

function biRender() {
    biCharts.forEach(chart => chart.destroy());
    biCharts = [];
    const container = document.getElementById("biWidgets");
    container.innerHTML = "";
    document.getElementById("biEmpty").classList.toggle("hidden", biBoard.widgets.length > 0);
    biBoard.widgets.forEach((widget, index) => {
        const { result, invalid } = biAggregate(biRows, widget);
        const card = document.createElement("section");
        card.className = "min-w-0 bg-white rounded-2xl border border-slate-200 p-4";
        card.innerHTML = `<div class="flex flex-wrap justify-between gap-2"><h3 class="font-bold text-sm">${esc(widget.title)}</h3>
            <div class="flex gap-2 text-xs"><button type="button" data-bi-action="move-up" data-index="${index}" aria-label="Di chuyển lên" title="Di chuyển lên" class="text-slate-500 hover:text-blue-600 disabled:opacity-30" ${index === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
            <button type="button" data-bi-action="move-down" data-index="${index}" aria-label="Di chuyển xuống" title="Di chuyển xuống" class="text-slate-500 hover:text-blue-600 disabled:opacity-30" ${index === biBoard.widgets.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
            <button type="button" data-bi-action="edit" data-index="${index}" class="text-blue-600">Sửa</button>
            <button data-bi-action="delete" data-index="${index}" class="text-red-600">Xóa</button></div></div>
            <p class="text-xs text-slate-500 mt-1">${esc(biMeasures[widget.measure])}${widget.measure === "revenue" ? " (VND)" : ""} · ${esc(biDimensions[widget.dimension])}${widget.timeGrain ? ` · Theo ${esc(biTimeGrains[widget.timeGrain].toLowerCase())}` : ""}${widget.filter ? ` · Lọc: ${esc(widget.filter)}` : ""}</p>
            ${widget.measure === "quantity" ? '<p class="text-xs text-amber-700 mt-1">Cộng trực tiếp, không quy đổi; ĐVT theo từng mã PTN, xem ở bảng hoặc chú giải khi rê chuột.</p>' : ""}
            ${biStockStatus(widget)}
            <p class="text-xs text-amber-700 mt-1">${invalid ? `Bỏ qua ${invalid} dòng thiếu hoặc sai chỉ tiêu.` : ""}</p>
            <div class="bi-content mt-3 overflow-auto max-h-[360px]"></div>`;
        container.appendChild(card);
        const content = card.querySelector(".bi-content");
        if (!result.length) {
            content.textContent = "Không có dữ liệu bán hàng phù hợp.";
            return;
        }
        if (widget.timeGrain) { biRenderTime(content, result, widget); return; }
        const stockTotals = biStockTotals(widget);
        if (widget.chart === "table") {
            content.innerHTML = `<table class="w-full text-xs text-left"><thead><tr><th class="p-2">Chiều phân tích</th><th class="p-2 text-right">Giá trị</th>${stockTotals.map(stock => `<th class="p-2 text-right whitespace-nowrap">${esc(biStockLabel(stock))}</th>`).join("")}</tr></thead><tbody>${result.map(group =>
                `<tr class="border-t"><td class="p-2">${esc(group.label)}</td><td class="p-2 text-right whitespace-nowrap">${esc(biValue(group, widget.measure))}</td>${stockTotals.map(stock => `<td class="p-2 text-right whitespace-nowrap">${esc(`${biStockValue(stock)} ${stock.unit}`)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
            return;
        }
        for (let offset = 0; offset < result.length; offset += 100) {
            const part = result.slice(offset, offset + 100);
            const wrap = document.createElement("div");
            wrap.className = "relative min-w-[450px]";
            wrap.style.height = `${Math.max(300, widget.chart === "bar" ? part.length * 38 : 300)}px`;
            const canvas = document.createElement("canvas");
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", widget.title);
            wrap.appendChild(canvas);
            content.appendChild(wrap);
            biCharts.push(new Chart(canvas.getContext("2d"), {
                type: widget.chart,
                data: { labels: part.map(group => group.label), datasets: [
                    { label: biMeasures[widget.measure], data: part.map(group => group.value), backgroundColor: "#3b82f6", borderColor: "#2563eb", borderRadius: 4 },
                    ...stockTotals.map((stock, i) => ({ type: "line", label: biStockLabel(stock), data: part.map(() => stock.value),
                        borderColor: ["#dc2626", "#d97706", "#7c3aed", "#0891b2"][i % 4], borderDash: [6, 4], pointRadius: 0, fill: false }))
                ] },
                options: { responsive: true, maintainAspectRatio: false, ...(widget.chart === "bar" ? { indexAxis: "y", scales: { y: { ticks: { autoSkip: false } } } } : {}),
                    plugins: { tooltip: { callbacks: { label: item => item.datasetIndex === 0
                        ? `${biMeasures[widget.measure]}: ${biValue(part[item.dataIndex], widget.measure)}`
                        : biStockLabel(stockTotals[item.datasetIndex - 1]) } } } }
            }));
        }
    });
    if (biBoard.widgets.some(widget => widget.measure === "quantity" && widget.stockBy) &&
        biStockRows === null && !biStockError) biLoadStock();
}

function biMoveWidget(index, offset) {
    if (!biBoard || biBusy || !Number.isInteger(index) || ![-1, 1].includes(offset)) return;
    const target = index + offset;
    if (index < 0 || index >= biBoard.widgets.length || target < 0 || target >= biBoard.widgets.length) return;
    [biBoard.widgets[index], biBoard.widgets[target]] = [biBoard.widgets[target], biBoard.widgets[index]];
    biDirty = true;
    biRender();
    biSetStatus("Thứ tự widget đã thay đổi; chọn Lưu bảng để lưu lại.");
}

function biOpenEditor(index) {
    if (!biBoard || biBusy) return;
    if (index === null && biBoard.widgets.length >= 30) return biSetStatus("Mỗi bảng tối đa 30 widget.");
    const widget = index === null ? { title: "", measure: "revenue", dimension: "month", chart: "bar", filter: "", limit: 0, stockBy: "" } : biBoard.widgets[index];
    biEditing = index;
    document.getElementById("biTitle").value = widget.title;
    document.getElementById("biMeasure").value = widget.measure;
    document.getElementById("biDimension").value = widget.dimension;
    document.getElementById("biChart").value = widget.chart;
    document.getElementById("biFilter").value = widget.filter;
    biSyncFilterSearch();
    document.getElementById("biLimit").value = String(widget.limit);
    document.getElementById("biTimeGrain").value = widget.timeGrain || "";
    document.getElementById("biStockSku").checked = widget.stockBy === "sku";
    document.getElementById("biStockPtn").checked = widget.stockBy === "ptn";
    biUpdateDimension();
    document.getElementById("biEditor").classList.remove("hidden");
    document.getElementById("biTitle").focus();
}

function biUpdateDimension() {
    const quantity = document.getElementById("biMeasure").value === "quantity";
    document.getElementById("biStockOptions").classList.toggle("hidden", !quantity);
    if (!quantity) {
        document.getElementById("biStockSku").checked = false;
        document.getElementById("biStockPtn").checked = false;
    }
    const dimension = document.getElementById("biDimension");
    [...dimension.options].forEach(option => { option.disabled = quantity && option.value !== "ptn"; });
    if (quantity) dimension.value = "ptn";
    const time = document.getElementById("biTimeGrain");
    time.disabled = dimension.value === "month";
    if (time.disabled) time.value = "";
    biCloseFilterSearch(false);
    biSyncFilterSearch();
}

function biMaterialFilterOptions() {
    const dimension = document.getElementById("biDimension").value;
    if (Object.hasOwn(biMaterialFilterOptionCache, dimension)) return biMaterialFilterOptionCache[dimension];
    const options = new Map();
    if (dimension === "ptn") {
        Object.keys(biMaterials).map(code => ptnOf({ ma_vt: code })).filter(Boolean).forEach(code => {
            const material = biMaterials[code];
            const name = material && String(material.ten_vt || "").trim();
            options.set(code, { value: code, label: `${name || "Không tìm thấy tên trong danh mục"} — ${code}` });
        });
    } else {
        const codeField = dimension === "category" ? "ma_nhvt" : "ma_nhvt1";
        const nameField = dimension === "category" ? "ten_nhvt" : "ten_nhvt1";
        Object.values(biMaterials).forEach(material => {
            if (!material || typeof material !== "object") return;
            const code = String(material[codeField] || "").trim();
            if (!code) return;
            const name = String(material[nameField] || "").trim();
            options.set(code, { value: code, label: `${name || code} — ${code}` });
        });
    }
    biMaterialFilterOptionCache[dimension] = [...options.values()].sort((a, b) => a.label.localeCompare(b.label, "vi", { numeric: true }));
    return biMaterialFilterOptionCache[dimension];
}

function biSyncFilterSearch() {
    const value = document.getElementById("biFilter").value;
    const option = biMaterialFilterDimensions.includes(document.getElementById("biDimension").value)
        ? biMaterialFilterOptions().find(item => item.value === value)
        : null;
    document.getElementById("biFilterSearch").value = option ? option.label : value;
}

function biCloseFilterSearch(restore = true) {
    const input = document.getElementById("biFilterSearch");
    const menu = document.getElementById("biFilterResults");
    menu.classList.add("hidden");
    biFilterMatches = [];
    biFilterActive = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (restore) biSyncFilterSearch();
}

function biRenderFilterSearch(query) {
    const input = document.getElementById("biFilterSearch");
    const menu = document.getElementById("biFilterResults");
    if (!biMaterialFilterDimensions.includes(document.getElementById("biDimension").value)) {
        biCloseFilterSearch(false);
        return;
    }
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 80)}px`;
    menu.style.maxHeight = `${Math.max(60, Math.min(280, window.innerHeight - Math.min(rect.bottom + 4, window.innerHeight - 80) - 8))}px`;
    const term = searchableText(query.trim());
    const matches = biMaterialFilterOptions().filter(option => searchableText(option.label).includes(term));
    const displayed = matches.slice(0, 100);
    menu.innerHTML = displayed.map((option, index) =>
        `<div id="biFilterResults-${index}" role="option" aria-selected="${option.value === document.getElementById("biFilter").value}" data-index="${index}" class="px-3 py-2 cursor-pointer hover:bg-blue-50 text-slate-700 break-words">${esc(option.label)}</div>`).join("")
        || '<div class="px-3 py-2 text-slate-500">Không tìm thấy kết quả.</div>';
    if (matches.length > displayed.length) {
        menu.insertAdjacentHTML("beforeend", `<div class="px-3 py-2 text-slate-500">Hiển thị 100 / ${matches.length} kết quả. Nhập thêm để tìm.</div>`);
    }
    biFilterMatches = displayed;
    biFilterActive = -1;
    menu.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
}

function biSetFilterSearchActive(index) {
    const input = document.getElementById("biFilterSearch");
    const menu = document.getElementById("biFilterResults");
    const options = [...menu.querySelectorAll("[role='option']")];
    if (index < 0 || index >= options.length) return;
    biFilterActive = index;
    options.forEach((option, optionIndex) => {
        option.classList.toggle("bg-blue-100", optionIndex === index);
    });
    input.setAttribute("aria-activedescendant", options[index].id);
    options[index].scrollIntoView({ block: "nearest" });
}

function biSelectFilterSearchOption(option) {
    document.getElementById("biFilter").value = option.value;
    document.getElementById("biFilterSearch").value = option.label;
    biCloseFilterSearch(false);
}

document.getElementById("biMeasure").addEventListener("change", biUpdateDimension);
document.getElementById("biDimension").addEventListener("change", biUpdateDimension);
document.getElementById("biFilterSearch").addEventListener("focus", event => biRenderFilterSearch(event.target.value));
document.getElementById("biFilterSearch").addEventListener("input", event => {
    document.getElementById("biFilter").value = event.target.value.trim();
    biRenderFilterSearch(event.target.value);
});
document.getElementById("biFilterSearch").addEventListener("keydown", event => {
    const menu = document.getElementById("biFilterResults");
    if (event.key === "Escape") {
        biCloseFilterSearch();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (menu.classList.contains("hidden")) biRenderFilterSearch(event.target.value);
        if (!biFilterMatches.length) return;
        event.preventDefault();
        const next = event.key === "ArrowDown"
            ? (biFilterActive + 1) % biFilterMatches.length
            : biFilterActive <= 0 ? biFilterMatches.length - 1 : biFilterActive - 1;
        biSetFilterSearchActive(next);
    } else if (event.key === "Enter" && !menu.classList.contains("hidden") && biFilterMatches.length) {
        event.preventDefault();
        const index = biFilterActive >= 0 ? biFilterActive : 0;
        biSelectFilterSearchOption(biFilterMatches[index]);
    }
});
document.getElementById("biFilterClear").addEventListener("click", () => {
    document.getElementById("biFilter").value = "";
    document.getElementById("biFilterSearch").value = "";
    biCloseFilterSearch(false);
    document.getElementById("biFilterSearch").focus();
});
document.getElementById("biFilterResults").addEventListener("mousedown", event => {
    if (event.target.closest("[role='option']")) event.preventDefault();
});
document.getElementById("biFilterResults").addEventListener("click", event => {
    const option = event.target.closest("[role='option']");
    if (!option) return;
    const selected = biFilterMatches[Number(option.dataset.index)];
    if (selected) biSelectFilterSearchOption(selected);
});
document.body.appendChild(document.getElementById("biFilterResults"));
document.addEventListener("click", event => {
    if (event.target.closest("#biFilterSearch, #biFilterResults")) return;
    if (document.getElementById("biFilterResults").classList.contains("hidden")) return;
    biCloseFilterSearch();
});
document.getElementById("biStockSku").addEventListener("change", event => {
    if (event.target.checked) document.getElementById("biStockPtn").checked = false;
});
document.getElementById("biStockPtn").addEventListener("change", event => {
    if (event.target.checked) document.getElementById("biStockSku").checked = false;
});
document.getElementById("biAdd").addEventListener("click", () => biOpenEditor(null));
document.getElementById("biCancel").addEventListener("click", () => {
    biCloseFilterSearch();
    document.getElementById("biEditor").classList.add("hidden");
});
document.getElementById("biReload").addEventListener("click", biLoadBoard);
document.getElementById("biSave").addEventListener("click", biSaveBoard);
document.getElementById("biApply").addEventListener("click", biApplyDates);
document.getElementById("biRefreshStock").addEventListener("click", biRefreshStock);
document.getElementById("biEditorForm").addEventListener("submit", event => {
    event.preventDefault();
    const title = document.getElementById("biTitle").value.trim();
    if (!title) { document.getElementById("biTitle").setCustomValidity("Vui lòng nhập tên widget."); document.getElementById("biTitle").reportValidity(); return; }
    document.getElementById("biTitle").setCustomValidity("");
    const widget = {
        id: biEditing === null ? crypto.randomUUID() : biBoard.widgets[biEditing].id,
        title, measure: document.getElementById("biMeasure").value, dimension: document.getElementById("biDimension").value,
        chart: document.getElementById("biChart").value, filter: document.getElementById("biFilter").value.trim(), limit: Number(document.getElementById("biLimit").value),
        timeGrain: document.getElementById("biTimeGrain").value,
        stockBy: document.getElementById("biStockSku").checked ? "sku" : document.getElementById("biStockPtn").checked ? "ptn" : ""
    };
    if (biEditing === null) biBoard.widgets.push(widget); else biBoard.widgets[biEditing] = widget;
    biDirty = true;
    biCloseFilterSearch();
    document.getElementById("biEditor").classList.add("hidden");
    biRender();
    biSetStatus("Widget đã cập nhật; hãy chọn Lưu bảng để lưu thay đổi.");
});
document.getElementById("biTitle").addEventListener("input", event => event.target.setCustomValidity(""));
document.getElementById("biWidgets").addEventListener("click", event => {
    const button = event.target.closest("[data-bi-action]");
    if (!button || biBusy) return;
    const index = Number(button.dataset.index);
    if (button.dataset.biAction === "edit") return biOpenEditor(index);
    if (button.dataset.biAction === "move-up") return biMoveWidget(index, -1);
    if (button.dataset.biAction === "move-down") return biMoveWidget(index, 1);
    if (button.dataset.biAction !== "delete") return;
    if (!confirm("Xóa widget này khỏi bảng?")) return;
    biBoard.widgets.splice(index, 1);
    biDirty = true;
    biRender();
    biSetStatus("Widget đã xóa; hãy chọn Lưu bảng để lưu thay đổi.");
});
