import type { CellValue, Worksheet } from "exceljs";

type ReportRecord = {
  reportType: "weekly" | "monthly";
  reportPeriod: string;
  generatedAt?: number | null;
};

type ReportData = {
  periodLabel: string;
  overview: {
    total: number;
    effective: number;
    bySource: Record<string, number>;
    sentiment: Record<string, number>;
    threat: Record<string, number>;
    relevance: Record<string, number>;
  };
  sources: {
    topDomains: Array<{
      domain: string;
      articles: number;
      negatives: number;
      stance: string | null;
    }>;
    hostileActivity: Array<{
      domain: string;
      articles: number;
      negatives: number;
    }>;
    newDomains: string[];
  };
  threats: {
    highThreatList: Array<{
      title: string | null;
      domain: string | null;
      url: string;
      sentimentScore: number | null;
    }>;
    topNegatives: Array<{
      title: string | null;
      domain: string | null;
      url: string;
      sentimentScore: number | null;
      threatLevel: string | null;
    }>;
    compare: {
      prevPeriodLabel: string;
      total: number;
      prevTotal: number;
      negatives: number;
      prevNegatives: number;
      highThreat: number;
      prevHighThreat: number;
    };
  };
  penetration: {
    citedDomainsCount: number;
    amplified: Array<{
      domain: string;
      aiPlatforms: number;
      aiCitations: number;
      negatives: number;
      stance: string | null;
    }>;
    newlyAmplifiedHostile: Array<{
      domain: string;
      aiPlatforms: number;
      firstCitedAt: number;
    }>;
  };
  costs: {
    analysisUsd: number;
    fetchUsd: number;
    totalUsd: number;
    byEngine: Record<string, { articles: number; fetchUsd: number }>;
  };
};

const RED = "E40012";
const DARK = "1F2937";
const MUTED = "6B7280";
const LIGHT = "F7F1F1";
const WHITE = "FFFFFF";
const BORDER = "E5E7EB";

function filename(report: ReportRecord, extension: string) {
  const type = report.reportType === "weekly" ? "周报" : "月报";
  return `舆情${type}_${report.reportPeriod}.${extension}`;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadMonitorReportExcel(
  report: ReportRecord,
  data: ReportData
) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "GEO+SEO 舆情系统";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = `${report.reportPeriod} 舆情报告`;
  workbook.title = filename(report, "xlsx");

  const titleStyle = {
    font: {
      name: "Microsoft YaHei",
      size: 18,
      bold: true,
      color: { argb: RED },
    },
    alignment: { vertical: "middle" as const, horizontal: "left" as const },
  };
  const sectionStyle = {
    font: {
      name: "Microsoft YaHei",
      size: 11,
      bold: true,
      color: { argb: WHITE },
    },
    fill: {
      type: "pattern" as const,
      pattern: "solid" as const,
      fgColor: { argb: RED },
    },
    alignment: { vertical: "middle" as const, horizontal: "left" as const },
  };
  const headerStyle = {
    font: {
      name: "Microsoft YaHei",
      size: 10,
      bold: true,
      color: { argb: DARK },
    },
    fill: {
      type: "pattern" as const,
      pattern: "solid" as const,
      fgColor: { argb: LIGHT },
    },
    alignment: { vertical: "middle" as const, horizontal: "center" as const },
    border: {
      bottom: { style: "thin" as const, color: { argb: BORDER } },
    },
  };

  const setupSheet = (name: string, widths: number[]) => {
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
      pageSetup: {
        paperSize: 9,
        orientation: widths.length > 6 ? "landscape" : "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.35,
          right: 0.35,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
      },
    });
    sheet.columns = widths.map(width => ({ width }));
    sheet.properties.defaultRowHeight = 20;
    return sheet;
  };

  const addTitle = (sheet: Worksheet, title: string, columns: number) => {
    sheet.mergeCells(1, 1, 1, columns);
    const cell = sheet.getCell(1, 1);
    cell.value = title;
    cell.style = titleStyle;
    sheet.getRow(1).height = 34;
  };

  const addSection = (sheet: Worksheet, title: string, columns: number) => {
    const row = sheet.addRow([title]);
    sheet.mergeCells(row.number, 1, row.number, columns);
    row.getCell(1).style = sectionStyle;
    row.height = 24;
  };

  const addTable = (
    sheet: Worksheet,
    headers: string[],
    rows: CellValue[][]
  ) => {
    const header = sheet.addRow(headers);
    header.eachCell(cell => {
      cell.style = headerStyle;
    });
    header.height = 23;
    for (const values of rows) {
      const row = sheet.addRow(values);
      row.alignment = { vertical: "top", wrapText: true };
      row.font = { name: "Microsoft YaHei", size: 10, color: { argb: DARK } };
      row.eachCell(cell => {
        cell.border = {
          bottom: { style: "hair", color: { argb: BORDER } },
        };
      });
    }
  };

  const overview = setupSheet("报告概览", [22, 24, 22, 24, 22, 24]);
  addTitle(
    overview,
    `${report.reportType === "weekly" ? "舆情周报" : "舆情月报"} ${report.reportPeriod}`,
    6
  );
  overview.addRow([
    "报告周期",
    data.periodLabel,
    "生成时间",
    report.generatedAt ? new Date(report.generatedAt) : new Date(),
  ]);
  overview.getCell("D2").numFmt = "yyyy-mm-dd hh:mm:ss";
  addSection(overview, "核心指标", 6);
  addTable(
    overview,
    ["指标", "本期", "上期", "变化", "补充", "数值"],
    [
      [
        "新增文章",
        data.overview.total,
        data.threats.compare.prevTotal,
        data.overview.total - data.threats.compare.prevTotal,
        "有效舆情",
        data.overview.effective,
      ],
      [
        "负面舆情",
        data.overview.sentiment.negative || 0,
        data.threats.compare.prevNegatives,
        (data.overview.sentiment.negative || 0) -
          data.threats.compare.prevNegatives,
        "高威胁",
        data.threats.compare.highThreat,
      ],
      [
        "本期总成本",
        data.costs.totalUsd,
        null,
        null,
        "AI分析成本",
        data.costs.analysisUsd,
      ],
      [
        "抓取成本",
        data.costs.fetchUsd,
        null,
        null,
        "AI引用信源",
        data.penetration.citedDomainsCount,
      ],
    ]
  );
  for (const cell of ["B7", "F7", "B8"])
    overview.getCell(cell).numFmt = "$0.0000";

  addSection(overview, "来源分布", 6);
  addTable(
    overview,
    ["来源", "文章数", "", "", "", ""],
    Object.entries(data.overview.bySource).map(([source, count]) => [
      source,
      count,
      "",
      "",
      "",
      "",
    ])
  );
  addSection(overview, "情绪 / 威胁 / 相关度分布", 6);
  const distributionKeys = new Set([
    ...Object.keys(data.overview.sentiment),
    ...Object.keys(data.overview.threat),
    ...Object.keys(data.overview.relevance),
  ]);
  addTable(
    overview,
    ["等级", "情绪", "威胁", "相关度", "", ""],
    Array.from(distributionKeys).map(key => [
      key,
      data.overview.sentiment[key] || 0,
      data.overview.threat[key] || 0,
      data.overview.relevance[key] || 0,
      "",
      "",
    ])
  );

  const sources = setupSheet("信源明细", [28, 14, 14, 16, 30]);
  addTitle(sources, `${report.reportPeriod} 信源明细`, 5);
  addSection(sources, "Top 活跃信源", 5);
  addTable(
    sources,
    ["域名", "文章数", "负面数", "立场", "备注"],
    data.sources.topDomains.map(item => [
      item.domain,
      item.articles,
      item.negatives,
      item.stance || "",
      "",
    ])
  );
  addSection(sources, "敌对信源动态", 5);
  addTable(
    sources,
    ["域名", "文章数", "负面数", "立场", "备注"],
    data.sources.hostileActivity.map(item => [
      item.domain,
      item.articles,
      item.negatives,
      "hostile",
      "",
    ])
  );
  addSection(sources, "本期新出现信源", 5);
  addTable(
    sources,
    ["域名", "序号", "", "", ""],
    data.sources.newDomains.map((domain, index) => [
      domain,
      index + 1,
      "",
      "",
      "",
    ])
  );

  const risks = setupSheet("风险清单", [12, 52, 24, 68, 14, 14]);
  addTitle(risks, `${report.reportPeriod} 风险与负面文章`, 6);
  addTable(
    risks,
    ["类型", "标题", "域名", "原文链接", "情绪分", "威胁等级"],
    [
      ...data.threats.highThreatList.map(item => [
        "高威胁",
        item.title || "",
        item.domain || "",
        item.url,
        item.sentimentScore,
        "high",
      ]),
      ...data.threats.topNegatives.map(item => [
        "负面",
        item.title || "",
        item.domain || "",
        item.url,
        item.sentimentScore,
        item.threatLevel || "",
      ]),
    ]
  );
  risks.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: Math.max(2, risks.rowCount), column: 6 },
  };
  risks.getColumn(4).eachCell((cell, rowNumber) => {
    if (rowNumber <= 2 || !cell.value) return;
    cell.value = {
      text: String(cell.value),
      hyperlink: String(cell.value),
      tooltip: "打开原文",
    };
    cell.font = {
      name: "Microsoft YaHei",
      size: 10,
      color: { argb: "2563EB" },
      underline: true,
    };
  });

  const geo = setupSheet("GEO穿透", [30, 15, 15, 14, 16, 24]);
  addTitle(geo, `${report.reportPeriod} GEO 穿透`, 6);
  addSection(geo, "活跃信源 × AI 引用", 6);
  addTable(
    geo,
    ["域名", "AI平台数", "AI引用次数", "负面数", "立场", "备注"],
    data.penetration.amplified.map(item => [
      item.domain,
      item.aiPlatforms,
      item.aiCitations,
      item.negatives,
      item.stance || "",
      "",
    ])
  );
  addSection(geo, "本期新进入 AI 引用的风险信源", 6);
  addTable(
    geo,
    ["域名", "AI平台数", "首次引用时间", "", "", ""],
    data.penetration.newlyAmplifiedHostile.map(item => [
      item.domain,
      item.aiPlatforms,
      item.firstCitedAt ? new Date(item.firstCitedAt) : null,
      "",
      "",
      "",
    ])
  );
  geo.getColumn(3).numFmt = "yyyy-mm-dd hh:mm:ss";

  const costs = setupSheet("成本明细", [26, 18, 18, 24]);
  addTitle(costs, `${report.reportPeriod} 采集与分析成本`, 4);
  addTable(
    costs,
    ["抓取引擎", "文章数", "抓取成本(USD)", "备注"],
    Object.entries(data.costs.byEngine).map(([engine, item]) => [
      engine,
      item.articles,
      item.fetchUsd,
      "",
    ])
  );
  costs.getColumn(3).numFmt = "$0.0000";
  addSection(costs, "成本汇总", 4);
  addTable(
    costs,
    ["项目", "金额(USD)", "", ""],
    [
      ["AI 分析", data.costs.analysisUsd, "", ""],
      ["内容抓取", data.costs.fetchUsd, "", ""],
      ["合计", data.costs.totalUsd, "", ""],
    ]
  );
  costs.getColumn(2).numFmt = "$0.0000";

  const bytes = await workbook.xlsx.writeBuffer();
  saveBlob(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename(report, "xlsx")
  );
}

export async function downloadMonitorReportPdf(
  report: ReportRecord,
  reportElement: HTMLElement
) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([
    import("html-to-image"),
    import("jspdf"),
  ]);
  const canvas = await toCanvas(reportElement, {
    backgroundColor: "#ffffff",
    cacheBust: true,
    canvasWidth: reportElement.scrollWidth,
    canvasHeight: reportElement.scrollHeight,
    pixelRatio: Math.min(2, Math.max(1.25, window.devicePixelRatio || 1)),
  });

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  const marginMm = 8;
  const contentWidthMm = pdf.internal.pageSize.getWidth() - marginMm * 2;
  const contentHeightMm = pdf.internal.pageSize.getHeight() - marginMm * 2;
  const pixelsPerPage = Math.max(
    1,
    Math.floor((canvas.width * contentHeightMm) / contentWidthMm)
  );

  for (
    let sourceY = 0, page = 0;
    sourceY < canvas.height;
    sourceY += pixelsPerPage, page++
  ) {
    const sliceHeight = Math.min(pixelsPerPage, canvas.height - sourceY);
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const context = pageCanvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 PDF 画布");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(
      canvas,
      0,
      sourceY,
      canvas.width,
      sliceHeight,
      0,
      0,
      canvas.width,
      sliceHeight
    );
    if (page > 0) pdf.addPage();
    const imageHeightMm = (sliceHeight * contentWidthMm) / canvas.width;
    pdf.addImage(
      pageCanvas.toDataURL("image/jpeg", 0.92),
      "JPEG",
      marginMm,
      marginMm,
      contentWidthMm,
      imageHeightMm,
      undefined,
      "FAST"
    );
  }

  pdf.setProperties({
    title: `${report.reportPeriod} sentiment report`,
    subject: "GEO+SEO sentiment monitoring report",
    creator: "GEO+SEO System",
  });
  pdf.save(filename(report, "pdf"));
}
