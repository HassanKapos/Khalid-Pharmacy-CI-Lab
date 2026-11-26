import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import type {
  PurchaseInvoice,
  SupplierStatementResult,
  StatementRow
} from './pharmacyDb';
/**
 * Format currency with SDG suffix
 */
function formatSdg(val: number): string {
  const formatted = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  if (val < 0) {
    return `(${formatted}) SDG`;
  }
  return `${formatted} SDG`;
}

/**
 * Sanitize filename for phone and desktop file systems
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_');
}

/**
 * Translate transaction type into Arabic
 */
function getTxTypeArabic(type: string): string {
  switch (type) {
    case 'PURCHASE_INVOICE':
      return 'فاتورة شراء';
    case 'PAYMENT':
      return 'سند صرف';
    case 'OPENING_BALANCE':
      return 'رصيد افتتاحي';
    case 'ADJUSTMENT':
      return 'تسوية محاسبية';
    case 'RETURN':
      return 'مرتجع مشتريات';
    default:
      return type;
  }
}

/**
 * Generate and download a professional, multi-page Arabic A4 PDF Statement of Account
 * 100% Client-side, Local-First, offline compatible.
 */
export async function downloadSupplierStatementPdf(
  statement: SupplierStatementResult,
  options?: {
    pharmacyName?: string;
    onProgress?: (status: string) => void;
  }
): Promise<{ fileName: string; blob: Blob; url: string }> {
  const supplier = statement.supplier;
  const supplierNameAr = supplier.name.ar || supplier.name.en || 'المورد';
  const supplierNameEn = supplier.name.en || '';
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);
  const fileName = `كشف_حساب_${sanitizeFileName(supplierNameAr)}_${dateStr}.pdf`;

  if (options?.onProgress) {
    options.onProgress('جاري تجهيز بيانات كشف الحساب وتنسيق الصفحات...');
  }

  // Calculate pages layout
  const rows: StatementRow[] = statement.rows || [];
  const totalRows = rows.length;

  // Slicing parameters for A4
  // Page 1 has large header + recap boxes -> fits ~12 rows
  // Subsequent pages have compact header -> fits ~22 rows
  const PAGE1_MAX_ROWS = 12;
  const OTHER_PAGE_MAX_ROWS = 22;

  const pageBatches: StatementRow[][] = [];
  if (totalRows === 0) {
    pageBatches.push([]);
  } else {
    pageBatches.push(rows.slice(0, PAGE1_MAX_ROWS));
    let startIdx = PAGE1_MAX_ROWS;
    while (startIdx < totalRows) {
      pageBatches.push(rows.slice(startIdx, startIdx + OTHER_PAGE_MAX_ROWS));
      startIdx += OTHER_PAGE_MAX_ROWS;
    }
  }

  // Check if summary & unpaid invoices section needs its own page
  const lastBatch = pageBatches[pageBatches.length - 1];
  const isMultiPage = pageBatches.length > 1;
  const maxAllowedOnLast = isMultiPage ? OTHER_PAGE_MAX_ROWS : PAGE1_MAX_ROWS;
  const unpaidCount = statement.unpaidInvoices?.length || 0;
  const extraLoad = unpaidCount > 0 ? 6 : 4; // weight of summary blocks in terms of rows

  let needSeparateSummaryPage = false;
  if (lastBatch.length + extraLoad > maxAllowedOnLast) {
    needSeparateSummaryPage = true;
  }

  const totalPages = pageBatches.length + (needSeparateSummaryPage ? 1 : 0);

  // Hidden off-screen render container
  const renderContainer = document.createElement('div');
  renderContainer.id = 'pdf-render-offscreen';
  renderContainer.style.position = 'fixed';
  renderContainer.style.left = '-9999px';
  renderContainer.style.top = '0';
  renderContainer.style.width = '794px'; // standard A4 @ 96 DPI
  renderContainer.style.backgroundColor = '#f8fafc';
  renderContainer.style.fontFamily = "'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif";
  renderContainer.style.direction = 'rtl';
  renderContainer.style.color = '#0f172a';
  renderContainer.style.boxSizing = 'border-box';
  document.body.appendChild(renderContainer);

  const pagesDomNodes: HTMLElement[] = [];

  try {
    for (let pIndex = 0; pIndex < pageBatches.length; pIndex++) {
      const pageNum = pIndex + 1;
      const batchRows = pageBatches[pIndex];
      const isFirst = pageNum === 1;
      const isLastContentPage = pageNum === pageBatches.length && !needSeparateSummaryPage;

      const pageEl = document.createElement('div');
      pageEl.style.width = '794px';
      pageEl.style.minHeight = '1123px';
      pageEl.style.height = '1123px';
      pageEl.style.padding = '36px 40px';
      pageEl.style.boxSizing = 'border-box';
      pageEl.style.backgroundColor = '#ffffff';
      pageEl.style.position = 'relative';
      pageEl.style.display = 'flex';
      pageEl.style.flexDirection = 'column';
      pageEl.style.justifyContent = 'space-between';
      pageEl.style.boxShadow = '0 0 10px rgba(0,0,0,0.05)';
      pageEl.style.marginBottom = '20px';

      // --- Page Inner Top Content ---
      let topHtml = '';

      if (isFirst) {
        // Detailed Header on Page 1
        topHtml += `
          <div>
            <!-- Header Top Bar -->
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #059669; padding-bottom: 14px; margin-bottom: 14px;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <div style="width: 32px; height: 32px; border-radius: 8px; background: #ecfdf5; border: 1px solid #a7f3d0; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #059669; font-size: 18px;">+</div>
                  <div>
                    <h1 style="margin: 0; font-size: 20px; font-weight: 800; color: #064e3b; line-height: 1.2;">صيدلية خالد | Khalid Pharmacy</h1>
                    <p style="margin: 2px 0 0 0; font-size: 11px; color: #64748b;">نظام إدارة المخزون والمبيعات والموردين المتكامل • الخرطوم، السودان</p>
                  </div>
                </div>
              </div>
              <div style="text-align: left; direction: ltr;">
                <span style="display: inline-block; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; color: #334155;">
                  STATEMENT OF ACCOUNT
                </span>
                <p style="margin: 4px 0 0 0; font-size: 10px; color: #64748b;">تاريخ الإصدار: <span style="font-family: monospace; font-weight: 700;">${dateStr} ${timeStr}</span></p>
              </div>
            </div>

            <!-- Title & Supplier Info Card -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; margin-bottom: 14px;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 15px; font-weight: 800; color: #0f172a;">كشف حساب المورد:</span>
                    <span style="font-size: 16px; font-weight: 800; color: #0284c7;">${supplierNameAr}</span>
                    ${supplierNameEn ? `<span style="font-size: 12px; color: #64748b;">(${supplierNameEn})</span>` : ''}
                  </div>
                  <div style="display: flex; flex-wrap: wrap; gap: 14px; font-size: 11px; color: #475569; margin-top: 6px;">
                    <span>كود المورد: <strong style="font-family: monospace; color: #0f172a;">${supplier.id}</strong></span>
                    ${supplier.phone ? `<span>الهاتف: <strong style="font-family: monospace; direction: ltr; display: inline-block;">${supplier.phone}</strong></span>` : ''}
                    ${supplier.contactPerson ? `<span>الشخص المسؤول: <strong>${supplier.contactPerson}</strong></span>` : ''}
                    ${supplier.city ? `<span>المدينة: <strong>${supplier.city}</strong></span>` : ''}
                    <span>شروط الدفع: <strong style="color: #059669;">${supplier.terms}</strong></span>
                  </div>
                </div>
                <div style="text-align: left; font-size: 11px; color: #475569;">
                  <div>فترة الكشف:</div>
                  <div style="font-weight: 700; color: #0f172a; margin-top: 2px;">
                    ${statement.startDate || statement.endDate ? `${statement.startDate || 'البداية'} إلى ${statement.endDate || 'حتى اليوم'}` : 'كافة الحركات التاريخية'}
                  </div>
                </div>
              </div>
            </div>

            <!-- 5 Financial Recap Boxes -->
            <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; text-align: center;">
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 6px;">
                <div style="font-size: 10px; color: #64748b; font-weight: 600;">الرصيد الافتتاحي</div>
                <div style="font-size: 12px; font-weight: 800; color: #1e293b; margin-top: 2px;">${formatSdg(statement.openingBalance)}</div>
              </div>

              <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 8px 6px;">
                <div style="font-size: 10px; color: #065f46; font-weight: 600;">إجمالي الدائن (مشتريات)</div>
                <div style="font-size: 12px; font-weight: 800; color: #047857; margin-top: 2px;">+${formatSdg(statement.totalCredits)}</div>
              </div>

              <div style="background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 8px 6px;">
                <div style="font-size: 10px; color: #115e59; font-weight: 600;">إجمالي المدين (سداد)</div>
                <div style="font-size: 12px; font-weight: 800; color: #0f766e; margin-top: 2px;">-${formatSdg(statement.totalDebits)}</div>
              </div>

              <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 8px 6px;">
                <div style="font-size: 10px; color: #1e40af; font-weight: 600;">صافي حركة الفترة</div>
                <div style="font-size: 12px; font-weight: 800; color: #1d4ed8; margin-top: 2px;">${formatSdg(statement.netPeriodChange)}</div>
              </div>

              <div style="background: #0f172a; border: 1px solid #0f172a; border-radius: 8px; padding: 8px 6px; color: #ffffff;">
                <div style="font-size: 10px; color: #94a3b8; font-weight: 600;">الرصيد الختامي المستحق</div>
                <div style="font-size: 13px; font-weight: 800; color: #34d399; margin-top: 2px;">${formatSdg(statement.closingBalance)}</div>
              </div>
            </div>
          </div>
        `;
      } else {
        // Compact Header for Page 2+
        topHtml += `
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; margin-bottom: 12px;">
            <div>
              <div style="font-size: 14px; font-weight: 800; color: #0f172a;">
                صيدلية خالد • كشف حساب: <span style="color: #0284c7;">${supplierNameAr}</span>
              </div>
              <div style="font-size: 10px; color: #64748b;">
                الفترة: ${statement.startDate || statement.endDate ? `${statement.startDate || 'البداية'} إلى ${statement.endDate || 'الآن'}` : 'كافة الحركات التاريخية'}
              </div>
            </div>
            <div style="text-align: left; font-size: 10px; color: #64748b;">
              صفحة ${pageNum} من ${totalPages}
            </div>
          </div>
        `;
      }

      // --- Table Section ---
      let tableHtml = `
        <table style="width: 100%; border-collapse: collapse; font-size: 10px; text-align: right;">
          <thead>
            <tr style="background: #f1f5f9; color: #334155; border-top: 1px solid #cbd5e1; border-bottom: 2px solid #cbd5e1;">
              <th style="padding: 7px 6px; text-align: center; width: 30px;">#</th>
              <th style="padding: 7px 8px; width: 75px;">التاريخ</th>
              <th style="padding: 7px 8px; width: 85px;">نوع الحركة</th>
              <th style="padding: 7px 8px; width: 95px;">رقم السند/المستند</th>
              <th style="padding: 7px 8px;">البيان والتفاصيل</th>
              <th style="padding: 7px 8px; text-align: left; width: 85px; color: #0f766e;">مدين (سداد)</th>
              <th style="padding: 7px 8px; text-align: left; width: 85px; color: #047857;">دائن (مشتريات)</th>
              <th style="padding: 7px 8px; text-align: left; width: 90px; font-weight: 800;">الرصيد الجاري</th>
            </tr>
          </thead>
          <tbody>
      `;

      if (batchRows.length === 0) {
        tableHtml += `
          <tr>
            <td colspan="8" style="padding: 30px; text-align: center; color: #94a3b8; font-size: 11px;">
              لا توجد حركات مالية مسجلة لهذا المورد في الفترة المحددة.
            </td>
          </tr>
        `;
      } else {
        const offset = (pageNum === 1) ? 0 : PAGE1_MAX_ROWS + (pageNum - 2) * OTHER_PAGE_MAX_ROWS;
        batchRows.forEach((row, idx) => {
          const globalIdx = offset + idx + 1;
          const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
          const typeBadge = getTxTypeArabic(row.type);
          const docNum = row.voucherNumber || row.invoiceNumber || row.referenceId || '—';
          const notes = (row.notes || '—') + (row.paymentMethod ? ` (${row.paymentMethod})` : '');

          tableHtml += `
            <tr style="background: ${bg}; border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 6px; text-align: center; color: #94a3b8; font-family: monospace;">${globalIdx}</td>
              <td style="padding: 6px 8px; font-family: monospace; color: #475569; white-space: nowrap;">${row.date}</td>
              <td style="padding: 6px 8px; white-space: nowrap;">
                <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; ${
                  row.type === 'PURCHASE_INVOICE'
                    ? 'background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0;'
                    : row.type === 'PAYMENT'
                    ? 'background: #f0fdfa; color: #115e59; border: 1px solid #99f6e4;'
                    : row.type === 'OPENING_BALANCE'
                    ? 'background: #faf5ff; color: #6b21a8; border: 1px solid #e9d5ff;'
                    : 'background: #fffbeb; color: #92400e; border: 1px solid #fde68a;'
                }">
                  ${typeBadge}
                </span>
                ${row.isReversal ? '<span style="color: #e11d48; font-weight: bold; font-size: 9px; margin-right: 3px;">(ملغي)</span>' : ''}
              </td>
              <td style="padding: 6px 8px; font-family: monospace; font-weight: 700; color: #1e293b;">${docNum}</td>
              <td style="padding: 6px 8px; color: #475569; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${notes}</td>
              <td style="padding: 6px 8px; text-align: left; font-family: monospace; font-weight: 700; color: #0f766e; white-space: nowrap;">
                ${row.displayDebit > 0 ? formatSdg(row.displayDebit) : '—'}
              </td>
              <td style="padding: 6px 8px; text-align: left; font-family: monospace; font-weight: 700; color: #047857; white-space: nowrap;">
                ${row.displayCredit > 0 ? formatSdg(row.displayCredit) : '—'}
              </td>
              <td style="padding: 6px 8px; text-align: left; font-family: monospace; font-weight: 800; color: #0f172a; background: #f8fafc; white-space: nowrap;">
                ${formatSdg(row.runningBalance)}
              </td>
            </tr>
          `;
        });
      }

      tableHtml += `
          </tbody>
        </table>
      `;

      // If this is the last content page, append the unpaid invoices & totals & stamp section
      let bottomSummaryHtml = '';
      if (isLastContentPage) {
        bottomSummaryHtml = generateSummaryAndStampHtml(statement);
      }

      // Page Footer
      const footerHtml = `
        <div style="border-top: 1px solid #e2e8f0; padding-top: 8px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: #94a3b8;">
          <div>صادر آلياً من نظام صيدلية خالد المحلي • Khalid Pharmacy POS & Accounting System</div>
          <div>صفحة ${pageNum} من ${totalPages}</div>
        </div>
      `;

      pageEl.innerHTML = `
        <div style="display: flex; flex-direction: column;">
          ${topHtml}
          ${tableHtml}
          ${bottomSummaryHtml}
        </div>
        ${footerHtml}
      `;

      renderContainer.appendChild(pageEl);
      pagesDomNodes.push(pageEl);
    }

    // Separate summary page if needed
    if (needSeparateSummaryPage) {
      const summaryPageEl = document.createElement('div');
      summaryPageEl.style.width = '794px';
      summaryPageEl.style.minHeight = '1123px';
      summaryPageEl.style.height = '1123px';
      summaryPageEl.style.padding = '36px 40px';
      summaryPageEl.style.boxSizing = 'border-box';
      summaryPageEl.style.backgroundColor = '#ffffff';
      summaryPageEl.style.position = 'relative';
      summaryPageEl.style.display = 'flex';
      summaryPageEl.style.flexDirection = 'column';
      summaryPageEl.style.justifyContent = 'space-between';

      const topHeader = `
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #059669; padding-bottom: 10px; margin-bottom: 14px;">
          <div>
            <div style="font-size: 15px; font-weight: 800; color: #064e3b;">صيدلية خالد • ملخص الحساب والإقرار المالي</div>
            <div style="font-size: 11px; color: #64748b;">المورد: ${supplierNameAr} (${supplier.id})</div>
          </div>
          <div style="font-size: 10px; color: #64748b;">صفحة ${totalPages} من ${totalPages}</div>
        </div>
      `;

      const summaryContent = generateSummaryAndStampHtml(statement);

      const footerHtml = `
        <div style="border-top: 1px solid #e2e8f0; padding-top: 8px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: #94a3b8;">
          <div>صادر آلياً من نظام صيدلية خالد المحلي • معتمد محاسبياً</div>
          <div>صفحة ${totalPages} من ${totalPages}</div>
        </div>
      `;

      summaryPageEl.innerHTML = `
        <div style="display: flex; flex-direction: column;">
          ${topHeader}
          ${summaryContent}
        </div>
        ${footerHtml}
      `;

      renderContainer.appendChild(summaryPageEl);
      pagesDomNodes.push(summaryPageEl);
    }

    // Initialize jsPDF
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true
    });

    // Render each page DOM node with html2canvas and inject into jsPDF
    for (let i = 0; i < pagesDomNodes.length; i++) {
      if (options?.onProgress) {
        options.onProgress(`جاري إنشاء صفحة ${i + 1} من ${pagesDomNodes.length}...`);
      }

      const pageNode = pagesDomNodes[i];
      const canvas = await html2canvas(pageNode, {
        scale: 2, // 2x for sharp 300 DPI text rendering
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.95);

      if (i > 0) {
        pdf.addPage('a4', 'portrait');
      }

      // Standard A4 in mm: 210 x 297
      pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    }

    if (options?.onProgress) {
      options.onProgress('جاري حفظ الملف وتجهيز التحميل...');
    }

    // Generate Blob and download
    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);

    // Trigger download
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // If mobile device supports Web Share API with files, also offer share
    if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
      try {
        const file = new File([blob], fileName, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          // File is shareable
          console.log('[PDF] File is ready and shareable via Web Share API');
        }
      } catch (e) {
        console.warn('[PDF] Share API check skipped:', e);
      }
    }

    return { fileName, blob, url };
  } finally {
    // Clean up DOM node
    if (renderContainer.parentNode) {
      renderContainer.parentNode.removeChild(renderContainer);
    }
  }
}

/**
 * Generate HTML for unpaid invoices, final balances, and official stamp/signatures
 */
function generateSummaryAndStampHtml(statement: SupplierStatementResult): string {
  const unpaidInvoices = statement.unpaidInvoices || [];
  let unpaidHtml = '';

  if (unpaidInvoices.length > 0) {
    unpaidHtml = `
      <div style="margin-top: 14px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; padding: 10px 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="font-size: 11px; font-weight: 800; color: #9f1239;">
            فواتير الشراء المستحقة وغير المسددة (${unpaidInvoices.length} فاتورة):
          </div>
          <div style="font-size: 11px; font-weight: 800; color: #e11d48;">
            إجمالي المتبقي: ${formatSdg(statement.unpaidInvoicesTotalRemaining)}
          </div>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; font-size: 10px;">
          ${unpaidInvoices
            .slice(0, 10)
            .map(
  (inv: PurchaseInvoice) => `
            <div style="background: #ffffff; border: 1px solid #fecdd3; border-radius: 6px; padding: 3px 8px; color: #334155;">
              <span style="font-family: monospace; font-weight: 700;">#${inv.invoiceNumber}</span>
              <span style="color: #64748b; margin-right: 4px;">(${inv.invoiceDate})</span>:
              <strong style="color: #e11d48; margin-right: 2px;">${formatSdg(inv.remainingAmount)}</strong>
            </div>
          `
            )
            .join('')}
          ${
            unpaidInvoices.length > 10
              ? `<div style="padding: 3px 8px; font-size: 10px; color: #9f1239;">+ ${unpaidInvoices.length - 10} فواتير أخرى مسجلة</div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  return `
    ${unpaidHtml}

    <!-- Final Reconciliation Box -->
    <div style="margin-top: 14px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 11px; color: #334155;">
        <span>إجمالي حركات الفترة: <strong>${statement.rows.length} حركة</strong></span>
        <span style="margin-right: 14px;">إجمالي المدين: <strong style="color: #0f766e;">${formatSdg(statement.totalDebits)}</strong></span>
        <span style="margin-right: 14px;">إجمالي الدائن: <strong style="color: #047857;">${formatSdg(statement.totalCredits)}</strong></span>
      </div>
      <div style="font-size: 12px; font-weight: 800; color: #0f172a;">
        صافي الرصيد الختامي المستحق للمورد:
        <span style="color: #059669; font-size: 14px; margin-right: 4px;">${formatSdg(statement.closingBalance)}</span>
      </div>
    </div>

    <!-- Official Stamp & Signatures -->
    <div style="margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; text-align: center; font-size: 10px; color: #475569;">
      <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px 8px; min-height: 75px;">
        <div style="font-weight: 700; color: #1e293b; margin-bottom: 30px;">توقيع المحاسب المسؤول</div>
        <div style="border-top: 1px dotted #94a3b8; width: 80%; margin: 0 auto; padding-top: 4px;">صيدلية خالد</div>
      </div>

      <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px 8px; min-height: 75px;">
        <div style="font-weight: 700; color: #1e293b; margin-bottom: 30px;">ختم الصيدلية المعتمد</div>
        <div style="border-top: 1px dotted #94a3b8; width: 80%; margin: 0 auto; padding-top: 4px;">الختم الرسمي</div>
      </div>

      <div style="border: 1px dashed #cbd5e1; border-radius: 8px; padding: 12px 8px; min-height: 75px;">
        <div style="font-weight: 700; color: #1e293b; margin-bottom: 30px;">توقيع واستلام مندوب المورد</div>
        <div style="border-top: 1px dotted #94a3b8; width: 80%; margin: 0 auto; padding-top: 4px;">الاسم: ....................</div>
      </div>
    </div>
  `;
}
