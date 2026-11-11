const biDimensions = {
    month: "Tháng/năm", customer: "Khách hàng", staff: "Nhân viên kinh doanh",
    business: "Nhóm kinh doanh", category: "Nhóm vật tư", category1: "Nhóm vật tư 1", ptn: "Sản phẩm PTN"
};
const biMeasures = { revenue: "Doanh thu thuần", quantity: "Sản lượng sau trả lại", orders: "Số đơn hàng" };
const biTimeGrains = { day: "Ngày", month: "Tháng", quarter: "Quý", year: "Năm" };
let biBoard = null;
let biRows = [];
let biMaterials = {};
let biOwner = null;
let biGeneration = 0;
let biBusy = false;
let biDirty = false;
let biEditing = null;
let biCharts = [];

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
    biOwner = null;
    biDirty = false;
    biSetBusy(false);
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
        const value = widget.measure === "quantity" ? row.sl_ban_sau_tra_lai : row.doanh_thu_thuan;
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
    if (widget.chart === "table") {
        const table = document.createElement("table");
        table.className = "w-full text-xs text-left";
        const head = document.createElement("thead");
        head.innerHTML = "<tr><th class=\"p-2\">Thời gian</th><th class=\"p-2\">Chiều phân tích</th><th class=\"p-2 text-right\">Giá trị</th></tr>";
        table.appendChild(head);
        const body = document.createElement("tbody");
        for (const period of periods) for (const group of result) {
            const cell = group.periods.get(period);
            if (!cell) continue;
            const row = document.createElement("tr");
            row.className = "border-t";
            row.innerHTML = `<td class="p-2 whitespace-nowrap">${esc(period)}</td><td class="p-2">${esc(group.label)}</td><td class="p-2 text-right whitespace-nowrap">${esc(biValue({ value: cell.value, unit: group.unit }, widget.measure))}</td>`;
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
                data: { labels: part, datasets: groups.map((group, i) => ({
                    label: widget.measure === "quantity" ? `${group.label} (${group.unit})` : group.label,
                    data: part.map(period => group.periods.has(period) ? group.periods.get(period).value : null),
                    backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length], borderRadius: 4
                })) },
                options: { responsive: true, maintainAspectRatio: false, spanGaps: false,
                    scales: { x: { title: { display: true, text: biTimeGrains[widget.timeGrain] } } },
                    plugins: { tooltip: { callbacks: { label: item => {
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
            <div class="flex gap-2 text-xs"><button data-bi-action="edit" data-index="${index}" class="text-blue-600">Sửa</button>
            <button data-bi-action="delete" data-index="${index}" class="text-red-600">Xóa</button></div></div>
            <p class="text-xs text-slate-500 mt-1">${esc(biMeasures[widget.measure])}${widget.measure === "revenue" ? " (VND)" : ""} · ${esc(biDimensions[widget.dimension])}${widget.timeGrain ? ` · Theo ${esc(biTimeGrains[widget.timeGrain].toLowerCase())}` : ""}${widget.filter ? ` · Lọc: ${esc(widget.filter)}` : ""}</p>
            ${widget.measure === "quantity" ? '<p class="text-xs text-amber-700 mt-1">Cộng trực tiếp, không quy đổi; ĐVT theo từng mã PTN, xem ở bảng hoặc chú giải khi rê chuột.</p>' : ""}
            <p class="text-xs text-amber-700 mt-1">${invalid ? `Bỏ qua ${invalid} dòng thiếu hoặc sai chỉ tiêu.` : ""}</p>
            <div class="bi-content mt-3 overflow-auto max-h-[360px]"></div>`;
        container.appendChild(card);
        const content = card.querySelector(".bi-content");
        if (!result.length) { content.textContent = "Không có dữ liệu phù hợp."; return; }
        if (widget.timeGrain) { biRenderTime(content, result, widget); return; }
        if (widget.chart === "table") {
            content.innerHTML = `<table class="w-full text-xs text-left"><thead><tr><th class="p-2">Chiều phân tích</th><th class="p-2 text-right">Giá trị</th></tr></thead><tbody>${result.map(group =>
                `<tr class="border-t"><td class="p-2">${esc(group.label)}</td><td class="p-2 text-right whitespace-nowrap">${esc(biValue(group, widget.measure))}</td></tr>`).join("")}</tbody></table>`;
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
                data: { labels: part.map(group => group.label), datasets: [{ label: biMeasures[widget.measure], data: part.map(group => group.value), backgroundColor: "#3b82f6", borderColor: "#2563eb", borderRadius: 4 }] },
                options: { responsive: true, maintainAspectRatio: false, ...(widget.chart === "bar" ? { indexAxis: "y", scales: { y: { ticks: { autoSkip: false } } } } : {}),
                    plugins: { tooltip: { callbacks: { label: item => `${biMeasures[widget.measure]}: ${biValue(part[item.dataIndex], widget.measure)}` } } } }
            }));
        }
    });
}

function biOpenEditor(index) {
    if (!biBoard || biBusy) return;
    if (index === null && biBoard.widgets.length >= 30) return biSetStatus("Mỗi bảng tối đa 30 widget.");
    const widget = index === null ? { title: "", measure: "revenue", dimension: "month", chart: "bar", filter: "", limit: 20 } : biBoard.widgets[index];
    biEditing = index;
    document.getElementById("biTitle").value = widget.title;
    document.getElementById("biMeasure").value = widget.measure;
    document.getElementById("biDimension").value = widget.dimension;
    document.getElementById("biChart").value = widget.chart;
    document.getElementById("biFilter").value = widget.filter;
    document.getElementById("biLimit").value = String(widget.limit);
    document.getElementById("biTimeGrain").value = widget.timeGrain || "";
    biUpdateDimension();
    document.getElementById("biEditor").classList.remove("hidden");
    document.getElementById("biTitle").focus();
}

function biUpdateDimension() {
    const quantity = document.getElementById("biMeasure").value === "quantity";
    const dimension = document.getElementById("biDimension");
    [...dimension.options].forEach(option => { option.disabled = quantity && option.value !== "ptn"; });
    if (quantity) dimension.value = "ptn";
    const time = document.getElementById("biTimeGrain");
    time.disabled = dimension.value === "month";
    if (time.disabled) time.value = "";
}

document.getElementById("biMeasure").addEventListener("change", biUpdateDimension);
document.getElementById("biDimension").addEventListener("change", biUpdateDimension);
document.getElementById("biAdd").addEventListener("click", () => biOpenEditor(null));
document.getElementById("biCancel").addEventListener("click", () => document.getElementById("biEditor").classList.add("hidden"));
document.getElementById("biReload").addEventListener("click", biLoadBoard);
document.getElementById("biSave").addEventListener("click", biSaveBoard);
document.getElementById("biApply").addEventListener("click", biApplyDates);
document.getElementById("biEditorForm").addEventListener("submit", event => {
    event.preventDefault();
    const title = document.getElementById("biTitle").value.trim();
    if (!title) { document.getElementById("biTitle").setCustomValidity("Vui lòng nhập tên widget."); document.getElementById("biTitle").reportValidity(); return; }
    document.getElementById("biTitle").setCustomValidity("");
    const widget = {
        id: biEditing === null ? crypto.randomUUID() : biBoard.widgets[biEditing].id,
        title, measure: document.getElementById("biMeasure").value, dimension: document.getElementById("biDimension").value,
        chart: document.getElementById("biChart").value, filter: document.getElementById("biFilter").value.trim(), limit: Number(document.getElementById("biLimit").value),
        timeGrain: document.getElementById("biTimeGrain").value
    };
    if (biEditing === null) biBoard.widgets.push(widget); else biBoard.widgets[biEditing] = widget;
    biDirty = true;
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
    if (!confirm("Xóa widget này khỏi bảng?")) return;
    biBoard.widgets.splice(index, 1);
    biDirty = true;
    biRender();
    biSetStatus("Widget đã xóa; hãy chọn Lưu bảng để lưu thay đổi.");
});
