import {
  applyPropertyDecision,
  clampPercent,
  containsInternalFragment,
  effectiveCandidateStatus,
  isKnownCaseStage,
  moveItem,
  stageAtOrBeyond,
  undoPropertyDecision,
  validateNormalizedModels,
} from "./domain.mjs";
import {
  createApprovedReplyDTO,
  createMockReplyApproval,
  createRentalDataAdapter,
  MockApprovedReplyGateway,
} from "./api-adapter.mjs";

(async () => {
  const accessGate = document.getElementById("access-gate");
  const appShell = document.getElementById("app-shell");
  const appView = document.getElementById("app-view");
  const modalRoot = document.getElementById("modal-root");
  const toastRegion = document.getElementById("toast-region");
  const bottomNav = document.querySelector(".bottom-nav");
  const escapeHTML = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  /**
   * Access guard runs before any application view or mock business data is rendered.
   * employee: app / pending: employee application / customer: denied.
   */
  function guardAccessBeforeRender() {
    const role = new URLSearchParams(window.location.search).get("role") || "customer";

    if (role === "employee") {
      accessGate.hidden = true;
      appShell.hidden = false;
      return true;
    }

    appShell.hidden = true;
    accessGate.hidden = false;

    if (role === "pending") {
      accessGate.innerHTML = `
        <section class="access-panel" aria-labelledby="access-title">
          <div class="access-brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <div>
              <p class="brand-name">ROOM PILOT</p>
              <p class="brand-subtitle">LINE賃貸営業OS <span class="mock-badge">モック</span></p>
            </div>
          </div>
          <div class="access-main">
            <div class="access-illustration" aria-hidden="true">⌛</div>
            <p class="access-kicker">EMPLOYEE APPLICATION</p>
            <h1 id="access-title" class="access-title">社員申請を<br />確認中です</h1>
            <p class="access-copy">管理者の承認が完了すると、LINEからそのままROOM PILOTを利用できます。</p>
            <div class="access-info" aria-label="申請状況">
              <div class="access-info-row"><span>申請状況</span><strong>承認待ち</strong></div>
              <div class="access-info-row"><span>申請ID</span><strong>RP-0811-24</strong></div>
              <div class="access-info-row"><span>通常の確認時間</span><strong>1営業日以内</strong></div>
            </div>
            <button class="primary-button wide-button" type="button" data-access-action="reload">状態を再確認</button>
          </div>
          <p class="access-footer">実API・LIFF・ITANDIは未接続のモック画面です</p>
        </section>`;
    } else {
      accessGate.innerHTML = `
        <section class="access-panel" aria-labelledby="access-title">
          <div class="access-brand">
            <span class="brand-mark" aria-hidden="true">R</span>
            <div>
              <p class="brand-name">ROOM PILOT</p>
              <p class="brand-subtitle">LINE賃貸営業OS <span class="mock-badge">モック</span></p>
            </div>
          </div>
          <div class="access-main">
            <div class="access-illustration" aria-hidden="true">×</div>
            <p class="access-kicker">EMPLOYEES ONLY</p>
            <h1 id="access-title" class="access-title">このページには<br />アクセスできません</h1>
            <p class="access-copy">ROOM PILOTは社員専用です。お部屋探しのお客様は、LINEのトーク画面から担当者へご連絡ください。</p>
            <button class="line-button wide-button" type="button" data-access-action="back">LINEに戻る</button>
          </div>
          <p class="access-footer">権限については店舗管理者へお問い合わせください</p>
        </section>`;
    }

    accessGate.addEventListener("click", (event) => {
      const action = event.target.closest("[data-access-action]")?.dataset.accessAction;
      if (action === "reload") window.location.reload();
      if (action === "back") {
        if (window.history.length > 1) window.history.back();
        else window.location.assign("https://line.me/");
      }
    });

    return false;
  }

  if (!guardAccessBeforeRender()) return;

  function setNavigationAvailable(available) {
    bottomNav?.toggleAttribute("inert", !available);
    if (available) bottomNav?.removeAttribute("aria-hidden");
    else bottomNav?.setAttribute("aria-hidden", "true");
  }

  function renderBootstrapSkeleton() {
    setNavigationAvailable(false);
    appShell.classList.add("is-bootstrapping");
    appView.innerHTML = `
      <section class="view bootstrap-view" role="status" aria-live="polite" aria-label="営業データを読み込み中">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line title"></div>
        <div class="skeleton-grid"><div class="skeleton-card"></div><div class="skeleton-card"></div></div>
        <div class="skeleton-line medium"></div>
        <div class="skeleton-panel"></div>
        <p class="sr-only">営業データを読み込んでいます</p>
      </section>`;
  }

  function renderBootstrapError(error) {
    setNavigationAvailable(false);
    appShell.classList.remove("is-bootstrapping");
    appShell.classList.add("has-bootstrap-error");
    const timeout = error?.code === "TIMEOUT";
    appView.innerHTML = `
      <section class="view" aria-labelledby="api-error-title">
        <div class="empty-state api-error-state">
          <div class="empty-state-inner">
            <div class="empty-icon danger" aria-hidden="true">!</div>
            <p class="eyebrow">${timeout ? "TIMEOUT" : "CONNECTION ERROR"}</p>
            <h1 id="api-error-title" class="empty-title">${timeout ? "読み込みに時間がかかっています" : "データを読み込めませんでした"}</h1>
            <p class="empty-copy">${escapeHTML(error?.message || "通信状態を確認して、もう一度お試しください。")}</p>
            <button class="primary-button" type="button" data-bootstrap-action="retry">再試行する</button>
            <p class="small-copy" style="margin-top:12px">入力内容は送信されていません</p>
          </div>
        </div>
      </section>`;
    appView.querySelector("[data-bootstrap-action='retry']")?.addEventListener("click", () => window.location.reload());
  }

  renderBootstrapSkeleton();
  const dataAdapter = createRentalDataAdapter();
  let adapterState;
  try {
    adapterState = await dataAdapter.bootstrap();
  } catch (error) {
    renderBootstrapError(error);
    return;
  }
  appShell.classList.remove("is-bootstrapping");
  setNavigationAvailable(true);

  const APP_VERSION = 2;
  const STORAGE_KEY = `room-pilot:v${APP_VERSION}`;
  const VALID_TABS = ["customers", "properties", "today", "viewings", "cases"];
  const WIDGET_KEYS = ["priority", "recommendation", "deadlines", "timeline"];
  const PROPERTY_FIELD_KEYS = ["listing", "ad", "rent", "management", "address", "viewing", "moveIn", "initialCost", "note"];
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
  const MOCK_NOW = Date.parse("2026-08-11T11:20:00+09:00");

  const propertySeeds = [
    ["中目黒リバーサイド", "中目黒駅 徒歩6分・1LDK 38.2㎡", 18.2, 1.2, "photo-1522708323590-d24dbb6b0267"],
    ["恵比寿ミモザレジデンス", "恵比寿駅 徒歩8分・1K 28.1㎡", 14.8, 0.8, "photo-1502672260266-1c1ef2d93688"],
    ["代官山コート", "代官山駅 徒歩5分・1DK 31.6㎡", 16.5, 1.0, "photo-1493663284031-b7e3aefcae8e"],
    ["祐天寺テラス", "祐天寺駅 徒歩4分・1LDK 36.5㎡", 17.1, 0.9, "photo-1560448204-e02f11c3d0e2"],
    ["学芸大学ソレイユ", "学芸大学駅 徒歩7分・1DK 30.4㎡", 13.9, 0.7, "photo-1560185008-b033106af5c3"],
    ["三軒茶屋パークサイド", "三軒茶屋駅 徒歩9分・1LDK 40.1㎡", 17.8, 1.1, "photo-1564013799919-ab600027ffc6"],
    ["池尻ブルーム", "池尻大橋駅 徒歩3分・1K 26.8㎡", 13.4, 0.6, "photo-1600566753086-00f18fb6b3ea"],
    ["目黒グリーンヒル", "目黒駅 徒歩10分・1LDK 42.0㎡", 19.2, 1.0, "photo-1600585154340-be6161a56a0c"],
    ["白金台ルーチェ", "白金台駅 徒歩6分・1K 29.7㎡", 15.6, 0.8, "photo-1600566753190-17f0baa2a6c3"],
    ["広尾アーバンネスト", "広尾駅 徒歩8分・1LDK 37.9㎡", 19.8, 1.2, "photo-1600210492486-724fe5c67fb0"],
    ["品川ベイフロント", "品川駅 徒歩12分・1LDK 44.8㎡", 18.6, 1.4, "photo-1545324418-cc1a3fa10c00"],
    ["五反田クレスト", "五反田駅 徒歩5分・1DK 32.3㎡", 14.5, 0.9, "photo-1600607687939-ce8a6c25118c"],
    ["武蔵小山フラット", "武蔵小山駅 徒歩4分・1K 27.5㎡", 12.9, 0.7, "photo-1600607687920-4e2a09cf159d"],
    ["自由が丘ノース", "自由が丘駅 徒歩9分・1LDK 39.4㎡", 17.6, 1.0, "photo-1600566752355-35792bedcfea"],
    ["都立大学ラフィネ", "都立大学駅 徒歩6分・1DK 33.1㎡", 14.2, 0.8, "photo-1600585154526-990dced4db0d"],
    ["大岡山スカイ", "大岡山駅 徒歩5分・1K 25.9㎡", 11.8, 0.6, "photo-1600047509807-ba8f99d2cdde"],
    ["二子玉川リーフ", "二子玉川駅 徒歩8分・1LDK 41.6㎡", 16.9, 1.1, "photo-1618221195710-dd6b41faaea6"],
    ["駒沢オークハウス", "駒沢大学駅 徒歩7分・1DK 34.8㎡", 14.7, 0.8, "photo-1615873968403-89e068629265"],
    ["桜新町アトリエ", "桜新町駅 徒歩4分・1LDK 38.7㎡", 16.2, 0.9, "photo-1600210491892-03d54c0aaf87"],
    ["用賀フォレスト", "用賀駅 徒歩6分・1K 28.6㎡", 12.7, 0.7, "photo-1600607688969-a5bfcd646154"],
  ];

  /** @type {Array<{id:string,name:string,kana:string,assignedTo:string,unassigned:boolean,priority:string,lastContactAt:string,source:string,status:string,stage:string,lineSummary:string,progress:number,searchConditionId:string}>} */
  const Customer = [
    {
      id: "c1",
      name: "藤田 さくら",
      kana: "ふじた さくら",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "urgent",
      lastContactAt: "2026-08-11T11:10:00+09:00",
      source: "LINE広告",
      status: "内見待ち",
      stage: "物件提案",
      lineSummary: "在宅勤務が増えたため、日当たりと仕事スペースを優先。週末の午前中なら内見しやすいとのこと。",
      progress: 42,
      searchConditionId: "sc1",
    },
    {
      id: "c2",
      name: "石井 健太",
      kana: "いしい けんた",
      assignedTo: "",
      unassigned: true,
      priority: "urgent",
      lastContactAt: "2026-08-11T11:16:00+09:00",
      source: "店舗QR",
      status: "新規",
      stage: "初回対応",
      lineSummary: "転勤に伴う住み替え。来月上旬までの入居を希望しているが、勤務先の最寄りは未確認。",
      progress: 12,
      searchConditionId: "sc2",
    },
    {
      id: "c3",
      name: "中村 美咲",
      kana: "なかむら みさき",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T10:20:00+09:00",
      source: "SUUMO",
      status: "内見調整中",
      stage: "内見調整",
      lineSummary: "候補2件のうち、駅距離より収納量を重視。8月15日午後の内見を希望。",
      progress: 58,
      searchConditionId: "sc3",
    },
    {
      id: "c4",
      name: "高橋 亮",
      kana: "たかはし りょう",
      assignedTo: "田中",
      unassigned: false,
      priority: "neutral",
      lastContactAt: "2026-08-10T16:00:00+09:00",
      source: "紹介",
      status: "書類待ち",
      stage: "申込準備",
      lineSummary: "内見済み物件で申込を検討中。初期費用の概算を確認してから意思決定予定。",
      progress: 70,
      searchConditionId: "sc4",
    },
    {
      id: "c5",
      name: "森田 結衣",
      kana: "もりた ゆい",
      assignedTo: "",
      unassigned: true,
      priority: "warning",
      lastContactAt: "2026-08-11T10:52:00+09:00",
      source: "Instagram",
      status: "新規",
      stage: "初回対応",
      lineSummary: "ペット可の1LDKを希望。エリアと賃料上限をヒアリングする必要あり。",
      progress: 8,
      searchConditionId: "sc5",
    },
    {
      id: "c6",
      name: "小林 航平",
      kana: "こばやし こうへい",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "neutral",
      lastContactAt: "2026-08-08T11:20:00+09:00",
      source: "HOME'S",
      status: "保留",
      stage: "追客中",
      lineSummary: "更新時期に合わせて情報収集中。急ぎではないが、築浅と角部屋への反応が良い。",
      progress: 31,
      searchConditionId: "sc6",
    },
    {
      id: "c7",
      name: "田辺 直樹",
      kana: "たなべ なおき",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T09:20:00+09:00",
      source: "既存顧客",
      status: "契約準備",
      stage: "契約準備",
      lineSummary: "審査承認済み。契約日時と鍵渡し方法の最終確認を進めている。",
      progress: 88,
      searchConditionId: "sc7",
    },
    {
      id: "c8",
      name: "山口 彩",
      kana: "やまぐち あや",
      assignedTo: "佐藤",
      unassigned: false,
      priority: "warning",
      lastContactAt: "2026-08-11T08:40:00+09:00",
      source: "LINE広告",
      status: "審査中",
      stage: "審査中",
      lineSummary: "申込受付済み。保証会社からの追加確認事項に回答し、審査結果を待っている。",
      progress: 79,
      searchConditionId: "sc8",
    },
  ];

  /** @type {Array<{id:string,customerId:string,updatedAt:string,items:Array<{key:string,label:string,value:string,status:'confirmed'|'inferred'|'unknown'}>}>} */
  const SearchCondition = [
    {
      id: "sc1",
      customerId: "c1",
      items: [
        { label: "希望エリア", value: "中目黒・恵比寿・祐天寺", status: "confirmed" },
        { label: "賃料上限", value: "管理費込 20万円", status: "confirmed" },
        { label: "間取り", value: "1LDKが本命", status: "inferred" },
        { label: "入居希望日", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc2",
      customerId: "c2",
      items: [
        { label: "入居希望", value: "9月上旬まで", status: "confirmed" },
        { label: "賃料上限", value: "16万円前後", status: "inferred" },
        { label: "勤務先・沿線", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc3",
      customerId: "c3",
      items: [
        { label: "希望エリア", value: "三軒茶屋〜学芸大学", status: "confirmed" },
        { label: "収納", value: "WICまたは大型収納", status: "confirmed" },
        { label: "駅距離", value: "徒歩12分まで許容", status: "inferred" },
      ],
    },
    {
      id: "sc4",
      customerId: "c4",
      items: [
        { label: "希望エリア", value: "目黒・五反田", status: "confirmed" },
        { label: "初期費用", value: "60万円以内を希望", status: "confirmed" },
      ],
    },
    {
      id: "sc5",
      customerId: "c5",
      items: [
        { label: "こだわり", value: "ペット相談可", status: "confirmed" },
        { label: "間取り", value: "1LDK", status: "confirmed" },
        { label: "希望エリア", value: "まだ確認できていません", status: "unknown" },
      ],
    },
    {
      id: "sc6",
      customerId: "c6",
      items: [
        { label: "こだわり", value: "築浅・角部屋", status: "inferred" },
        { label: "時期", value: "2か月以内", status: "confirmed" },
      ],
    },
    {
      id: "sc7",
      customerId: "c7",
      items: [
        { label: "契約物件", value: "二子玉川リーフ", status: "confirmed" },
        { label: "鍵渡し", value: "8月20日 午前", status: "confirmed" },
      ],
    },
    {
      id: "sc8",
      customerId: "c8",
      items: [
        { label: "申込物件", value: "五反田クレスト", status: "confirmed" },
        { label: "入居希望", value: "9月1日", status: "confirmed" },
      ],
    },
  ].map((condition) => ({
    ...condition,
    updatedAt: "2026-08-11T11:20:00+09:00",
    items: condition.items.map((item, index) => ({ key: `${condition.id}-item-${index + 1}`, ...item })),
  }));

  const sourceTimes = [
    "2026-08-11T11:08:00+09:00",
    "2026-08-11T10:20:00+09:00",
    "2026-08-11T09:00:00+09:00",
    "2026-08-09T09:00:00+09:00",
  ];

  /** Normalized property facts. Customer-specific matching lives in CandidateProperty. */
  const Property = propertySeeds.map((seed, index) => ({
    id: `p${index + 1}`,
    itandiPropertyId: `mock-itandi-${String(index + 1).padStart(3, "0")}`,
    name: seed[0],
    address: seed[1],
    rentYen: Math.round(seed[2] * 10_000),
    managementFeeYen: Math.round(seed[3] * 10_000),
    imageUrl: `https://images.unsplash.com/${seed[4]}?auto=format&fit=crop&w=900&q=82`,
    listingStatus: index === 13 ? "募集終了" : index % 6 === 0 ? "申込あり" : "募集中",
    listedAt: index % 3 === 0
      ? "2026-08-11T09:00:00+09:00"
      : index % 3 === 1
        ? "2026-08-10T09:00:00+09:00"
        : "2026-08-09T09:00:00+09:00",
    sourceUpdatedAt: sourceTimes[index % sourceTimes.length],
    fetchedAt: "2026-08-11T11:20:00+09:00",
    viewingAvailable: index % 5 === 0 ? "要確認" : index % 4 === 0 ? "8/13〜" : "本日可",
    moveInAt: index % 3 === 0 ? "即入居可" : index % 3 === 1 ? "9月上旬" : "8月下旬",
    initialCostYen: Math.round((seed[2] + seed[3]) * (index % 2 ? 3.4 : 3.8) * 10_000),
    publicNote: index % 3 === 0 ? "短期解約違約金あり。先行申込相談可。" : index % 3 === 1 ? "退去前。写真は同タイプ別部屋です。" : "保証会社利用必須。法人契約相談可。",
    internal: {
      ad: index % 4 === 0 ? "AD 200" : index % 3 === 0 ? "AD 150" : index % 2 === 0 ? "AD 100" : "AD 50",
      managementCompanyNote: index % 5 === 0 ? "元付へ事前確認" : "特記事項なし",
    },
  }));

  const initialLikes = Object.freeze({ c1: ["p18"], c3: ["p5", "p6"] });
  const reasonSets = [
    ["希望沿線", "日当たり", "予算内"],
    ["駅徒歩10分以内", "間取り", "入居時期"],
    ["在宅スペース", "築浅", "管理費込予算"],
    ["初期費用", "収納", "内見可能日"],
  ];

  /** Normalized customer × property relation used by every matching view. */
  const CandidateProperty = Customer.flatMap((customer, customerIndex) =>
    Property.map((property, propertyIndex) => ({
      id: `cp-${customer.id}-${property.id}`,
      customerId: customer.id,
      propertyId: property.id,
      status: initialLikes[customer.id]?.includes(property.id) ? "liked" : "unreviewed",
      matchScore: Math.max(56, 96 - ((propertyIndex * 3 + customerIndex * 7) % 39)),
      matchReasons: reasonSets[(propertyIndex + customerIndex) % reasonSets.length],
      createdAt: "2026-08-11T09:00:00+09:00",
      updatedAt: "2026-08-11T11:20:00+09:00",
    })),
  );

  /** @type {Array<{id:string,customerId:string,propertyId:string,date:string,time:string,range:'today'|'week',meetingPlace:string,vacancyConfirmed:boolean,keyConfirmed:boolean,keyNote:string,routeOrder:number,status:string,impression:string,temperature:string,nextAction:string}>} */
  const Viewing = [
    {
      id: "v1",
      customerId: "c3",
      propertyId: "p6",
      date: "8月11日",
      time: "13:30",
      range: "today",
      meetingPlace: "三軒茶屋駅 南口B",
      vacancyConfirmed: true,
      keyConfirmed: true,
      keyNote: "現地対応・管理会社 30分前連絡",
      routeOrder: 1,
      status: "確定",
      impression: "",
      temperature: "比較検討",
      nextAction: "申込へ進む",
    },
    {
      id: "v2",
      customerId: "c1",
      propertyId: "p1",
      date: "8月11日",
      time: "15:00",
      range: "today",
      meetingPlace: "物件エントランス前",
      vacancyConfirmed: false,
      keyConfirmed: false,
      keyNote: "社内キーボックス B-12 / 暗証情報は表示しません",
      routeOrder: 2,
      status: "確認待ち",
      impression: "",
      temperature: "比較検討",
      nextAction: "申込へ進む",
    },
    {
      id: "v3",
      customerId: "c4",
      propertyId: "p8",
      date: "8月13日",
      time: "11:00",
      range: "week",
      meetingPlace: "目黒駅 正面口",
      vacancyConfirmed: true,
      keyConfirmed: false,
      keyNote: "管理会社へ鍵取り 10:15",
      routeOrder: 1,
      status: "確定",
      impression: "初期費用を確認したい",
      temperature: "前向き",
      nextAction: "申込へ進む",
    },
    {
      id: "v4",
      customerId: "c7",
      propertyId: "p17",
      date: "8月15日",
      time: "14:30",
      range: "week",
      meetingPlace: "二子玉川駅 改札前",
      vacancyConfirmed: false,
      keyConfirmed: false,
      keyNote: "前日までに管理会社へ確認",
      routeOrder: 2,
      status: "仮押さえ",
      impression: "",
      temperature: "比較検討",
      nextAction: "ほかの物件を提案",
    },
  ];

  /** @type {Array<{id:string,customerId:string,propertyId:string,stage:string,nextAction:string,dueAt:string,documentStatus:string,applicationStatus:string,updatedAt:string}>} */
  const Case = [
    { id: "case1", customerId: "c6", propertyId: "p19", stage: "追客中", nextAction: "新着2件をLINEで提案", dueAt: "2026-08-12T10:00:00+09:00", documentStatus: "未着手", applicationStatus: "未申込", updatedAt: "2026-08-11T09:10:00+09:00" },
    { id: "case2", customerId: "c1", propertyId: "p1", stage: "内見調整", nextAction: "空室と鍵を再確認", dueAt: "2026-08-11T12:00:00+09:00", documentStatus: "不要", applicationStatus: "未申込", updatedAt: "2026-08-11T10:55:00+09:00" },
    { id: "case3", customerId: "c3", propertyId: "p6", stage: "内見調整", nextAction: "内見後の感想を記録", dueAt: "2026-08-11T16:30:00+09:00", documentStatus: "不要", applicationStatus: "未申込", updatedAt: "2026-08-11T10:40:00+09:00" },
    { id: "case4", customerId: "c4", propertyId: "p8", stage: "申込準備", nextAction: "初期費用明細を共有", dueAt: "2026-08-13T17:00:00+09:00", documentStatus: "本人確認書類 待ち", applicationStatus: "入力 60%", updatedAt: "2026-08-11T08:50:00+09:00" },
    { id: "case5", customerId: "c8", propertyId: "p12", stage: "審査中", nextAction: "保証会社の追加質問へ回答", dueAt: "2026-08-14T12:00:00+09:00", documentStatus: "追加書類 1点", applicationStatus: "審査受付済み", updatedAt: "2026-08-11T11:05:00+09:00" },
    { id: "case6", customerId: "c7", propertyId: "p17", stage: "契約準備", nextAction: "契約日時を最終確認", dueAt: "2026-08-16T18:00:00+09:00", documentStatus: "契約書作成中", applicationStatus: "承認済み", updatedAt: "2026-08-11T10:15:00+09:00" },
  ];

  /** @type {Array<{id:string,kind:'priority'|'deadline',title:string,customerId:string,dueAt:string,urgency:string,action:string,status:'todo'|'done'}>} */
  const TodayAction = [
    { id: "ta1", kind: "priority", title: "空室と鍵を再確認", customerId: "c1", dueAt: "2026-08-11T12:00:00+09:00", urgency: "urgent", action: "内見準備", status: "todo" },
    { id: "ta2", kind: "priority", title: "初回LINEへ返信", customerId: "c2", dueAt: "2026-08-11T11:35:00+09:00", urgency: "urgent", action: "返信", status: "todo" },
    { id: "ta3", kind: "priority", title: "初期費用明細を共有", customerId: "c4", dueAt: "2026-08-11T18:00:00+09:00", urgency: "warning", action: "書類", status: "todo" },
    { id: "ta6", kind: "priority", title: "新規反響の担当になる", customerId: "c5", dueAt: "2026-08-11T11:50:00+09:00", urgency: "warning", action: "未割当", status: "todo" },
    { id: "ta7", kind: "priority", title: "本日の内見ルートを確認", customerId: "c3", dueAt: "2026-08-11T13:00:00+09:00", urgency: "neutral", action: "内見", status: "todo" },
    { id: "ta8", kind: "priority", title: "契約・鍵渡し日時を確認", customerId: "c7", dueAt: "2026-08-11T18:00:00+09:00", urgency: "warning", action: "契約", status: "todo" },
    { id: "ta4", kind: "deadline", title: "申込情報の不足項目を確認", customerId: "c4", dueAt: "2026-08-11T17:00:00+09:00", urgency: "urgent", action: "申込", status: "todo" },
    { id: "ta5", kind: "deadline", title: "新着物件を2件提案", customerId: "c6", dueAt: "2026-08-12T10:00:00+09:00", urgency: "warning", action: "追客", status: "todo" },
  ];

  /** Device-local mock preference. Production ownership comes from the authenticated sales user. */
  const DisplayPreference = {
    salesUserId: "employee:sato",
    updatedAt: "2026-08-11T11:20:00+09:00",
    widgets: [...WIDGET_KEYS],
    propertyFields: [...PROPERTY_FIELD_KEYS],
    availableWidgets: [
      { id: "priority", label: "優先アクション", description: "今すぐ動く3件を表示" },
      { id: "deadlines", label: "期限", description: "今日・明日の締切を表示" },
      { id: "recommendation", label: "推奨する1操作", description: "迷わないための主行動を表示" },
      { id: "timeline", label: "今日のタイムライン", description: "予定と連絡を時系列で表示" },
    ],
    availablePropertyFields: [
      { id: "listing", label: "募集状況", description: "募集・申込・終了を表示" },
      { id: "ad", label: "AD", description: "社内限定の広告料情報" },
      { id: "rent", label: "賃料", description: "月額賃料" },
      { id: "management", label: "管理費", description: "共益費を含む月額" },
      { id: "address", label: "場所", description: "駅・徒歩・間取り" },
      { id: "viewing", label: "内見可否", description: "最新確認状態" },
      { id: "moveIn", label: "入居可能日", description: "入居開始の目安" },
      { id: "initialCost", label: "初期費用概算", description: "円単位モデルから表示" },
      { id: "note", label: "備考", description: "顧客へ説明できる公開備考" },
    ],
  };

  /** Common mock domain model. Real APIs / LIFF / ITANDI are intentionally not connected. */
  const MockModel = Object.freeze({
    Customer,
    Property,
    SearchCondition,
    CandidateProperty,
    Viewing,
    Case,
    TodayAction,
    DisplayPreference,
  });
  const modelErrors = validateNormalizedModels(MockModel);
  if (modelErrors.length) throw new Error(`Mock model contract violation: ${modelErrors.join("; ")}`);
  const INTERNAL_REPLY_FRAGMENTS = [
    ...Property.flatMap((property) => Object.values(property.internal || {})),
    ...Viewing.map((viewing) => viewing.keyNote),
  ];

  function createDefaultState() {
    return {
      version: APP_VERSION,
      activeTab: "today",
      selectedCustomerId: null,
      decisions: {},
      displayPreference: {
        widgets: [...DisplayPreference.widgets],
        propertyFields: [...DisplayPreference.propertyFields],
      },
    };
  }

  function sanitizeDecisions(value) {
    const output = {};
    if (!value || typeof value !== "object") return output;
    for (const customer of Customer) {
      const record = value[customer.id];
      if (!record || typeof record !== "object") continue;
      const validIds = new Set(Property.map((property) => property.id));
      const liked = Array.isArray(record.liked) ? record.liked.filter((id) => validIds.has(id)) : [];
      const skipped = Array.isArray(record.skipped) ? record.skipped.filter((id) => validIds.has(id) && !liked.includes(id)) : [];
      output[customer.id] = { liked: [...new Set(liked)], skipped: [...new Set(skipped)] };
    }
    return output;
  }

  function loadState() {
    const fallback = createDefaultState();
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (!stored || stored.version !== APP_VERSION) return fallback;
      const selectedCustomerId = Customer.some((customer) => customer.id === stored.selectedCustomerId)
        ? stored.selectedCustomerId
        : null;
      const widgets = Array.isArray(stored.displayPreference?.widgets)
        ? stored.displayPreference.widgets.filter((widget) => WIDGET_KEYS.includes(widget))
        : fallback.displayPreference.widgets;
      const propertyFields = Array.isArray(stored.displayPreference?.propertyFields)
        ? stored.displayPreference.propertyFields.filter((field) => PROPERTY_FIELD_KEYS.includes(field))
        : fallback.displayPreference.propertyFields;
      return {
        version: APP_VERSION,
        activeTab: VALID_TABS.includes(stored.activeTab) ? stored.activeTab : fallback.activeTab,
        selectedCustomerId,
        decisions: sanitizeDecisions(stored.decisions),
        displayPreference: {
          widgets: widgets.length ? [...new Set(widgets)] : fallback.displayPreference.widgets,
          propertyFields: propertyFields.length ? [...new Set(propertyFields)] : fallback.displayPreference.propertyFields,
        },
      };
    } catch {
      return fallback;
    }
  }

  let state = loadState();
  const runtime = {
    customerFilter: "all",
    customerSearch: "",
    viewingRange: "today",
    completedTodayActions: new Set(),
    previousFocus: null,
    undo: null,
    decisionPending: false,
    preferenceDraft: null,
    sentReplies: new Map(),
    replyPending: false,
    propertyStackObserver: null,
  };
  const replyGateway = new MockApprovedReplyGateway();
  let undoTimer = 0;
  let undoInterval = 0;
  let toastTimer = 0;

  function persistState() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: APP_VERSION,
          activeTab: state.activeTab,
          selectedCustomerId: state.selectedCustomerId,
          decisions: state.decisions,
          displayPreference: state.displayPreference,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function customerById(id) {
    return MockModel.Customer.find((customer) => customer.id === id);
  }

  function propertyById(id) {
    return MockModel.Property.find((property) => property.id === id);
  }

  function candidateByIds(customerId, propertyId) {
    return MockModel.CandidateProperty.find(
      (candidate) => candidate.customerId === customerId && candidate.propertyId === propertyId,
    );
  }

  function decisionRecord(customerId) {
    if (!state.decisions[customerId]) state.decisions[customerId] = { liked: [], skipped: [] };
    return state.decisions[customerId];
  }

  function candidateIdsForCustomer(customerId) {
    return Property.filter(
      (property) => effectiveStatusForProperty(customerId, property.id) === "liked",
    ).map((property) => property.id);
  }

  function effectiveStatusForProperty(customerId, propertyId) {
    const relation = candidateByIds(customerId, propertyId);
    return effectiveCandidateStatus(relation?.status, state.decisions[customerId], propertyId);
  }

  function matchingPropertiesForCustomer(customerId) {
    return [...Property].sort((left, right) => {
      const leftScore = candidateByIds(customerId, left.id)?.matchScore ?? 0;
      const rightScore = candidateByIds(customerId, right.id)?.matchScore ?? 0;
      return rightScore - leftScore;
    });
  }

  function isTodayActionDone(item) {
    if (item.status === "done") return true;
    if (item.id === "ta2") return runtime.sentReplies.has(item.customerId);
    if (item.id === "ta6") return !customerById(item.customerId)?.unassigned;
    return runtime.completedTodayActions.has(item.id);
  }

  function yen(value) {
    return `${Math.round(Number(value) || 0).toLocaleString("ja-JP")}円`;
  }

  function dateParts(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: String(date.getHours()).padStart(2, "0"),
      minute: String(date.getMinutes()).padStart(2, "0"),
    };
  }

  function relativeCustomerTime(iso) {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "連絡日時 未確認";
    const minutes = Math.max(0, Math.round((MOCK_NOW - timestamp) / 60_000));
    const parts = dateParts(iso);
    if (minutes < 60) return `${minutes}分前`;
    if (parts?.day === 11) return `${Math.floor(minutes / 60)}時間前`;
    if (parts?.day === 10) return "昨日";
    return `${Math.max(2, Math.floor(minutes / 1_440))}日前`;
  }

  function listedDate(iso) {
    const parts = dateParts(iso);
    return parts ? `${parts.month}/${parts.day}` : "掲載日 未確認";
  }

  function dueCalendarLabel(iso) {
    const parts = dateParts(iso);
    if (!parts) return "期限 未確認";
    const dayLabel = parts.day === 11 ? "今日" : parts.day === 12 ? "明日" : `${parts.month}/${parts.day}`;
    return `${dayLabel} ${parts.hour}:${parts.minute}`;
  }

  function priorityDueLabel(item) {
    const timestamp = Date.parse(item.dueAt);
    if (!Number.isFinite(timestamp)) return "期限 未確認";
    const minutes = Math.round((timestamp - MOCK_NOW) / 60_000);
    if (minutes > 0 && minutes <= 30) return `${minutes}分以内`;
    const parts = dateParts(item.dueAt);
    if (parts?.day === 11 && parts.hour === "18" && parts.minute === "00") return "今日中";
    if (parts?.day === 11) return `${parts.hour}:${parts.minute}まで`;
    return dueCalendarLabel(item.dueAt);
  }

  function relativeSourceTime(iso) {
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return "日時不明";
    const minutes = Math.max(0, Math.round((MOCK_NOW - timestamp) / 60_000));
    if (minutes < 60) return `${minutes}分前`;
    if (minutes < 24 * 60) return minutes < 120 ? "1時間前" : `${Math.floor(minutes / 60)}時間前`;
    return `${Math.floor(minutes / 1_440)}日前`;
  }

  function propertyIsStale(property) {
    const sourceUpdatedAt = Date.parse(property.sourceUpdatedAt);
    const fetchedAt = Date.parse(property.fetchedAt);
    return (
      adapterState.stale ||
      !Number.isFinite(sourceUpdatedAt) ||
      !Number.isFinite(fetchedAt) ||
      sourceUpdatedAt > fetchedAt ||
      fetchedAt - sourceUpdatedAt > 24 * 60 * 60 * 1_000
    );
  }

  function showToast(message, duration = 2300) {
    if (runtime.undo) clearUndoToast();
    window.clearTimeout(toastTimer);
    toastRegion.innerHTML = `<div class="toast"><span>${escapeHTML(message)}</span></div>`;
    toastTimer = window.setTimeout(() => {
      toastRegion.innerHTML = "";
    }, duration);
  }

  function clearUndoToast() {
    window.clearTimeout(undoTimer);
    window.clearInterval(undoInterval);
    undoTimer = 0;
    undoInterval = 0;
    runtime.undo = null;
    toastRegion.innerHTML = "";
  }

  function showUndoToast(property, action, { storageFailed = false } = {}) {
    window.clearTimeout(toastTimer);
    window.clearTimeout(undoTimer);
    window.clearInterval(undoInterval);
    const verb = action === "liked" ? "候補に保存しました" : "スキップしました";
    let remaining = 5;
    const draw = () => {
      toastRegion.innerHTML = `
        <div class="toast">
          <span>「${escapeHTML(property.name)}」を${verb}${storageFailed ? " · 端末保存なし" : ""}</span>
          <button class="toast-button" type="button" data-action="undo-decision" aria-label="5秒以内に直前の判断を元に戻す">元に戻す <span data-undo-countdown aria-hidden="true">（${remaining}秒）</span></button>
        </div>`;
    };
    draw();
    undoInterval = window.setInterval(() => {
      remaining -= 1;
      const countdown = toastRegion.querySelector("[data-undo-countdown]");
      if (remaining > 0 && runtime.undo && countdown) countdown.textContent = `（${remaining}秒）`;
    }, 1000);
    undoTimer = window.setTimeout(clearUndoToast, 5000);
  }

  function renderApp({ focusMain = false, focusSelector = null } = {}) {
    const renderers = {
      customers: renderCustomers,
      properties: renderProperties,
      today: renderToday,
      viewings: renderViewings,
      cases: renderCases,
    };
    runtime.propertyStackObserver?.disconnect();
    runtime.propertyStackObserver = null;
    appView.innerHTML = renderers[state.activeTab]();
    document.querySelectorAll("[data-tab]").forEach((button) => {
      if (button.dataset.tab === state.activeTab) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (state.activeTab === "properties") attachSwipeInteractions();
    if (focusMain) appView.focus({ preventScroll: true });
    else if (focusSelector) window.requestAnimationFrame(() => appView.querySelector(focusSelector)?.focus({ preventScroll: true }));
  }

  function setActiveTab(tab) {
    if (!VALID_TABS.includes(tab) || tab === state.activeTab) return;
    if (runtime.undo) clearUndoToast();
    closeModal();
    state.activeTab = tab;
    const saved = persistState();
    window.scrollTo({ top: 0, behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
    renderApp({ focusMain: true });
    if (!saved) showToast("この端末では現在地を保存できませんでした");
  }

  function renderToday() {
    const priorities = TodayAction.filter((item) => item.kind === "priority");
    const deadlines = TodayAction.filter((item) => item.kind === "deadline");
    const replySent = runtime.sentReplies.has("c2");
    const widgets = {
      priority: `
        <section class="section" aria-labelledby="priority-heading">
          <div class="section-heading">
            <h2 id="priority-heading" class="section-title">優先アクション</h2>
            <span class="section-note">上から順に進める</span>
          </div>
          ${priorities.slice(0, 3).map((item, index) => renderPriorityAction(item, index)).join("")}
        </section>`,
      recommendation: `
        <section class="section" aria-labelledby="recommend-heading">
          <div class="section-heading">
            <h2 id="recommend-heading" class="section-title">推奨する1操作</h2>
            <span class="mini-badge">AI補助</span>
          </div>
          <div class="card recommend-card">
            <div class="row" style="gap: 13px; align-items: flex-start;">
              <span class="recommend-mark" aria-hidden="true">${replySent ? "✓" : "↗"}</span>
              <div>
                <h3 class="card-title">${replySent ? "石井さんへ返信済み" : "石井さんへの返信案を確認"}</h3>
                <p class="card-copy">${replySent ? "営業確認後の本文をモック送信記録へ保存しました。" : "初回返信を先に終えると、希望条件の回収と候補提案が今日中につながります。"}</p>
              </div>
            </div>
            ${replySent ? '<button class="ghost-button wide-button" type="button" data-action="open-reply">送信記録を確認</button>' : '<button class="primary-button wide-button" type="button" data-action="open-reply">返信案を確認する</button>'}
          </div>
        </section>`,
      deadlines: `
        <section class="section" aria-labelledby="deadline-heading">
          <div class="section-heading">
            <h2 id="deadline-heading" class="section-title">期限</h2>
            <span class="section-note">2件</span>
          </div>
          <ul class="deadline-list">
            ${deadlines.map((item) => {
              const customer = customerById(item.customerId);
              const [day, time] = dueCalendarLabel(item.dueAt).split(" ");
              return `<li><button class="deadline-row" type="button" data-action="open-customer" data-id="${customer.id}">
                <span class="deadline-date">${escapeHTML(day)}<br />${escapeHTML(time || "")}</span>
                <div class="deadline-main"><p class="deadline-title">${escapeHTML(item.title)}</p><p class="person-meta">${escapeHTML(customer.name)} · ${escapeHTML(item.action)}</p></div>
                <span class="chevron" aria-hidden="true">›</span>
              </button></li>`;
            }).join("")}
          </ul>
        </section>`,
      timeline: `
        <section class="section" aria-labelledby="timeline-heading">
          <div class="section-heading"><h2 id="timeline-heading" class="section-title">今日のタイムライン</h2><span class="section-note">現在 11:20</span></div>
          <ol class="timeline">
            ${[
              ["10:30", "管理会社へ空室確認", "中目黒リバーサイド", "past"],
              ["11:20", "現在", "次は内見準備", "now"],
              ["13:30", "内見 · 中村 美咲さん", "三軒茶屋駅 南口B集合", "future"],
              ["15:00", "内見 · 藤田 さくらさん", "物件エントランス前集合", "future"],
              ["17:00", "申込情報の確認期限", "高橋 亮さん", "future"],
            ].map(([time, title, copy, timing]) => `<li class="timeline-item ${timing}"><time class="timeline-time">${time}</time><span class="timeline-dot" aria-hidden="true"></span><div><p class="timeline-title">${title}</p><p class="timeline-copy">${copy}</p></div></li>`).join("")}
          </ol>
        </section>`,
    };
    return `
      <section class="view" aria-labelledby="today-title">
        <header class="view-header">
          <div>
            <p class="eyebrow">GOOD MORNING, 佐藤さん</p>
            <h1 id="today-title" class="page-title">今日の操縦席</h1>
          </div>
          <p class="date-chip">8月11日 火</p>
        </header>

        <div class="summary-grid" aria-label="本日の概要">
          <div class="metric-card"><span class="metric-label">優先アクション</span><strong class="metric-value">${priorities.length}<span class="metric-unit">件</span></strong></div>
          <div class="metric-card"><span class="metric-label">本日の内見</span><strong class="metric-value">2<span class="metric-unit">組</span></strong></div>
        </div>
        ${state.displayPreference.widgets.map((key) => widgets[key] || "").join("")}

        <section class="section">
          <button class="ghost-button wide-button" type="button" data-action="edit-preference" data-preference="widgets">表示ウィジェットを編集</button>
        </section>
      </section>`;
  }

  function renderPriorityAction(item, index) {
    const customer = customerById(item.customerId);
    const done = isTodayActionDone(item);
    const lockedDone = done && (item.id === "ta2" || item.id === "ta6");
    const processAction = item.id === "ta2" ? "open-reply" : item.id === "ta6" ? "open-customer" : "complete-today-action";
    const processId = item.id === "ta6" ? customer.id : item.id;
    const controlLabel = lockedDone
      ? `${item.title}は完了済み`
      : item.id === "ta2"
        ? "返信案を確認する"
        : item.id === "ta6"
          ? "担当取得へ進む"
          : `${item.title}を${done ? "未完了に戻す" : "完了にする"}`;
    return `
      <article class="card priority-card${done ? " is-done" : ""}">
        <div class="card-body">
          <div class="priority-top">
            <span class="priority-index" aria-hidden="true">0${index + 1}</span>
            <div class="priority-main">
              <h3 class="card-title">${done ? "完了 · " : ""}${escapeHTML(item.title)}</h3>
              <p class="card-copy">${escapeHTML(customer.name)} · ${escapeHTML(customer.status)}</p>
              <div class="priority-meta"><span class="status-pill ${item.urgency}">${escapeHTML(priorityDueLabel(item))}</span><span class="status-pill neutral">${escapeHTML(item.action)}</span></div>
            </div>
            <button class="icon-button" type="button" data-action="${processAction}" data-id="${processId}" ${lockedDone ? "disabled" : ""} aria-label="${escapeHTML(controlLabel)}">${lockedDone ? "✓" : item.id === "ta2" || item.id === "ta6" ? "→" : done ? "↶" : "✓"}</button>
          </div>
        </div>
      </article>`;
  }

  function renderCustomers() {
    const unassigned = Customer.filter((customer) => customer.unassigned);
    return `
      <section class="view" aria-labelledby="customers-title">
        <header class="view-header">
          <div><p class="eyebrow">CUSTOMERS</p><h1 id="customers-title" class="page-title">顧客</h1></div>
          <span class="date-chip">全 ${Customer.length}名</span>
        </header>

        <section class="card inbox-card" aria-labelledby="inbox-title">
          <div class="inbox-head">
            <div><h2 id="inbox-title" class="card-title">未割当箱</h2><p class="card-copy">新着を取りこぼさない</p></div>
            <span class="count-badge">${unassigned.length}</span>
          </div>
          ${unassigned.slice(0, 1).map((customer) => `<div class="inbox-person">
            <span class="person-avatar accent" aria-hidden="true">${escapeHTML(customer.name.slice(0, 1))}</span>
            <div class="person-main"><p class="person-name">${escapeHTML(customer.name)}</p><p class="person-meta">${escapeHTML(customer.source)} · ${escapeHTML(relativeCustomerTime(customer.lastContactAt))}</p></div>
            <button class="primary-button compact-button" type="button" data-action="open-customer" data-id="${customer.id}">確認</button>
          </div>`).join("")}
        </section>

        <div class="search-wrap">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <label class="sr-only" for="customer-search">顧客を検索</label>
          <input id="customer-search" class="search-input" type="search" placeholder="名前・条件・流入元で検索" autocomplete="off" value="${escapeHTML(runtime.customerSearch)}" />
        </div>
        <div class="filter-row" aria-label="顧客フィルター">
          ${[
            ["all", "すべて"],
            ["urgent", "要対応"],
            ["unassigned", "未割当"],
            ["followup", "追客中"],
          ].map(([id, label]) => `<button class="filter-chip" type="button" data-action="customer-filter" data-filter="${id}" aria-pressed="${runtime.customerFilter === id}">${label}</button>`).join("")}
        </div>

        <section class="section" aria-labelledby="customer-list-heading">
          <div class="section-heading"><h2 id="customer-list-heading" class="section-title">顧客一覧</h2><span id="customer-result-count" class="section-note"></span></div>
          <div id="customer-results">${renderCustomerResults()}</div>
        </section>
      </section>`;
  }

  function getFilteredCustomers() {
    const query = runtime.customerSearch.trim().toLocaleLowerCase("ja");
    return Customer.filter((customer) => {
      const matchesSearch = !query || [customer.name, customer.kana, customer.source, customer.status, customer.stage, customer.lineSummary]
        .some((value) => value.toLocaleLowerCase("ja").includes(query));
      const matchesFilter =
        runtime.customerFilter === "all" ||
        (runtime.customerFilter === "urgent" && customer.priority === "urgent") ||
        (runtime.customerFilter === "unassigned" && customer.unassigned) ||
        (runtime.customerFilter === "followup" && customer.stage === "追客中");
      return matchesSearch && matchesFilter;
    });
  }

  function renderCustomerResults() {
    const filtered = getFilteredCustomers();
    window.requestAnimationFrame(() => {
      const count = document.getElementById("customer-result-count");
      if (count) count.textContent = `${filtered.length}名`;
    });
    if (!filtered.length) {
      return `<div class="empty-state" style="min-height:220px"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">⌕</div><h3 class="empty-title">該当する顧客はいません</h3><p class="empty-copy">検索語やフィルターを変えてください。</p></div></div>`;
    }
    return `<ul class="customer-list">${filtered.map((customer) => {
      const condition = SearchCondition.find((item) => item.id === customer.searchConditionId);
      const summary = condition?.items.slice(0, 3).map((item) => item.value).join(" · ") || "条件確認中";
      const action = TodayAction.find((item) => item.customerId === customer.id);
      return `<li>
        <button class="customer-item ${state.selectedCustomerId === customer.id ? "selected" : ""}" type="button" data-action="open-customer" data-id="${customer.id}">
          <span class="person-avatar" aria-hidden="true">${escapeHTML(customer.name.slice(0, 1))}</span>
          <span class="person-main"><span class="person-name">${escapeHTML(customer.name)}${customer.unassigned ? '<span class="unread-dot" aria-label="未読あり"></span>' : ""}</span><span class="person-meta">${escapeHTML(customer.status)} · ${escapeHTML(relativeCustomerTime(customer.lastContactAt))}</span><span class="customer-condition">${escapeHTML(summary)}</span>${action ? `<span class="customer-next">次：${escapeHTML(action.title)} · ${escapeHTML(priorityDueLabel(action))}</span>` : ""}</span>
          <span class="customer-trailing"><span class="status-pill ${customer.priority}">${customer.unassigned ? "未割当" : escapeHTML(customer.assignedTo)}</span><span class="chevron" aria-hidden="true">›</span></span>
        </button>
      </li>`;
    }).join("")}</ul>`;
  }

  function refreshCustomerResults() {
    const results = document.getElementById("customer-results");
    if (results) results.innerHTML = renderCustomerResults();
  }

  function renderProperties() {
    const selected = customerById(state.selectedCustomerId);
    if (!selected) {
      return `
        <section class="view" aria-labelledby="properties-title">
          <header class="view-header"><div><p class="eyebrow">MATCHING</p><h1 id="properties-title" class="page-title">物件</h1></div></header>
          <div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">♙</div><h2 class="empty-title">先に顧客を選んでください</h2><p class="empty-copy">希望条件と照合して、一人ひとりに合う物件だけを表示します。</p><button class="secondary-button" type="button" data-action="go-customers">顧客を選ぶ</button></div></div>
        </section>`;
    }

    const orderedProperties = matchingPropertiesForCustomer(selected.id);
    const statuses = new Map(
      orderedProperties.map((property) => [property.id, effectiveStatusForProperty(selected.id, property.id)]),
    );
    const remaining = adapterState.empty
      ? []
      : orderedProperties.filter((property) => statuses.get(property.id) === "unreviewed");
    const likedCount = [...statuses.values()].filter((status) => status === "liked").length;
    const skippedCount = [...statuses.values()].filter((status) => status === "skipped").length;
    const cards = remaining.slice(0, 3);
    const handledCount = Property.length - remaining.length;
    return `
      <section class="view" aria-labelledby="properties-title">
        <div class="selected-customer-bar" aria-label="選択中の顧客">
          <div class="selection-copy"><span class="selection-dot" aria-hidden="true"></span><div><span class="selection-label">この顧客に提案</span><strong class="selection-name">${escapeHTML(selected.name)}</strong></div></div>
          <button class="ghost-button compact-button" type="button" data-action="go-customers">変更</button>
        </div>
        <header class="view-header">
          <div><p class="eyebrow">PROPERTY MATCH</p><h1 id="properties-title" class="page-title">物件を選ぶ</h1></div>
          <button class="ghost-button compact-button" type="button" data-action="edit-preference" data-preference="propertyFields">表示項目</button>
        </header>
        ${adapterState.stale ? '<div class="freshness-warning" role="status"><strong>情報が古い可能性があります</strong><span>空室・鍵・金額は提案前に再確認してください</span></div>' : ""}
        <div class="property-progress"><span>${remaining.length} / ${Property.length}件 未確認</span><span>保存 ${likedCount} · Skip ${skippedCount}</span></div>
        ${cards.length ? `
          <div class="property-stack" aria-live="polite">
            ${[...cards].reverse().map((property, reverseIndex) => {
              const index = cards.length - 1 - reverseIndex;
              return renderPropertyCard(property, index, index === 0, selected.id, handledCount + index + 1);
            }).join("")}
          </div>
          <div class="swipe-controls" aria-label="物件の判断">
            <button class="swipe-action skip" type="button" data-action="property-skip" data-id="${cards[0].id}"><span aria-hidden="true">←</span> Skip</button>
            <button class="swipe-action like" type="button" data-action="property-like" data-id="${cards[0].id}" ${cards[0].listingStatus === "募集終了" ? "disabled" : ""}><span aria-hidden="true">♡</span> ${cards[0].listingStatus === "募集終了" ? "募集終了" : "顧客候補へ保存"}</button>
          </div>
          <p class="swipe-hint">左へSkip · 右へLike　縦方向はそのままスクロールできます</p>` : adapterState.empty ? renderPropertyNoResults(selected) : renderPropertyEmpty(selected, { liked: likedCount, skipped: skippedCount })}
      </section>`;
  }

  function renderPropertyField(field, property, index) {
    const values = {
      listing: ["募集状況", property.listingStatus],
      ad: ["AD・社内限定", property.internal.ad],
      rent: ["賃料", yen(property.rentYen)],
      management: ["管理費／共益費", yen(property.managementFeeYen)],
      address: ["場所", property.address],
      viewing: ["内見可否", property.viewingAvailable],
      moveIn: ["入居可能日", property.moveInAt],
      initialCost: ["初期費用概算", yen(property.initialCostYen)],
      note: ["備考", property.publicNote],
    };
    const value = values[field];
    if (!value) return "";
    const wide = field === "address" || field === "note";
    const statusClass = field === "listing" && property.listingStatus === "募集終了" ? " danger-text" : "";
    return `<div class="property-data${wide ? " wide" : ""}${index === 0 ? " emphasized" : ""}"><span class="detail-label">${value[0]}${index === 0 ? " · 強調" : ""}</span><strong class="detail-value${statusClass}">${escapeHTML(value[1])}</strong></div>`;
  }

  function renderPropertyCard(property, index, isTop, customerId, absolutePosition) {
    const scales = [1, 0.96, 0.92];
    const offsets = [0, 12, 22];
    const candidate = candidateByIds(customerId, property.id);
    const stale = propertyIsStale(property);
    return `
      <article class="property-card ${isTop ? "top-card" : ""}" data-property-card data-property-id="${property.id}" data-listing-status="${property.listingStatus}" style="--stack-scale:${scales[index]};--stack-y:${offsets[index]}px;--stack-z:${3 - index}" ${isTop ? 'aria-label="現在の候補物件"' : 'aria-hidden="true"'}>
        <span class="swipe-badge like" aria-hidden="true">LIKE</span>
        <span class="swipe-badge skip" aria-hidden="true">SKIP</span>
        <div class="property-image">
          <img src="${escapeHTML(property.imageUrl)}" alt="${escapeHTML(property.name)}の室内写真" loading="${isTop ? "eager" : "lazy"}" referrerpolicy="no-referrer" draggable="false" />
          <span class="image-scrim" aria-hidden="true"></span>
          <span class="match-badge">一致率 ${clampPercent(candidate?.matchScore)}%</span>
          <div class="image-status"><span class="image-status-main ${stale ? "stale" : ""}">${escapeHTML(property.listingStatus)} ${escapeHTML(listedDate(property.listedAt))} · 更新 ${escapeHTML(relativeSourceTime(property.sourceUpdatedAt))}${stale ? " ⚠" : ""}</span><span class="image-counter">${absolutePosition} / ${Property.length}</span></div>
        </div>
        <div class="property-content">
          <div class="property-title-row">
            <div><h2 class="property-name">${escapeHTML(property.name)}</h2><p class="property-location">顧客別の条件照合結果</p></div>
            <span class="status-pill ${property.listingStatus === "募集終了" ? "urgent" : property.listingStatus === "申込あり" ? "warning" : "success"}">${escapeHTML(property.listingStatus)}</span>
          </div>
          <div class="property-data-grid">
            ${state.displayPreference.propertyFields.map((field, fieldIndex) => renderPropertyField(field, property, fieldIndex)).join("")}
          </div>
          <div class="match-reason">合う理由：${(candidate?.matchReasons || []).map(escapeHTML).join("・")}</div>
          ${stale ? '<p class="property-note stale-note">情報の鮮度が基準を超えています。空室再確認後に提案してください。</p>' : ""}
        </div>
      </article>`;
  }

  function renderPropertyEmpty(selected, decisions) {
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">✓</div><h2 class="empty-title">20件の確認が完了しました</h2><p class="empty-copy">${escapeHTML(selected.name)}さんの仕分け結果を比較して、返信案を確認できます。</p><button class="primary-button" type="button" data-action="review-candidates" data-id="${selected.id}">保存候補を比較</button>${decisions.skipped ? '<button class="ghost-button" type="button" data-action="relax-condition" style="margin-top:8px">Skipした物件を再確認</button>' : ""}<p class="small-copy" style="margin-top:12px">保存 ${decisions.liked}件 · Skip ${decisions.skipped}件</p></div></div>`;
  }

  function renderPropertyNoResults(selected) {
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon" aria-hidden="true">⌕</div><h2 class="empty-title">条件に合う物件が0件です</h2><p class="empty-copy">${escapeHTML(selected.name)}さんの絶対条件を保ったまま、駅徒歩または築年数を少し広げる案を確認してください。</p><button class="primary-button" type="button" data-action="retry-property-search">条件緩和案を確認</button><p class="small-copy" style="margin-top:12px">絶対条件は自動で緩めません</p></div></div>`;
  }

  function renderViewings() {
    const filtered = Viewing.filter((viewing) => viewing.range === runtime.viewingRange);
    const todayViewings = Viewing.filter((viewing) => viewing.range === "today").sort((a, b) => a.routeOrder - b.routeOrder);
    return `
      <section class="view" aria-labelledby="viewings-title">
        <header class="view-header"><div><p class="eyebrow">VIEWING DESK</p><h1 id="viewings-title" class="page-title">内見</h1></div><span class="date-chip">${filtered.length}組</span></header>
        <div class="segmented-control" aria-label="内見期間">
          <button class="segmented-button" type="button" data-action="viewing-range" data-range="today" aria-pressed="${runtime.viewingRange === "today"}">今日</button>
          <button class="segmented-button" type="button" data-action="viewing-range" data-range="week" aria-pressed="${runtime.viewingRange === "week"}">今週</button>
        </div>
        ${runtime.viewingRange === "today" ? `
          <section class="section" aria-labelledby="route-heading">
            <div class="section-heading"><h2 id="route-heading" class="section-title">推奨巡回順</h2><span class="mini-badge">移動 約25分</span></div>
            <div class="card route-card"><div class="route-head"><p class="small-copy">移動時間と鍵の受取を加味</p><span class="status-pill success">最短</span></div><ol class="route-list">
              ${todayViewings.map((viewing) => {
                const property = propertyById(viewing.propertyId);
                return `<li class="route-item"><span class="route-number">${viewing.routeOrder}</span><div><p class="route-title">${escapeHTML(property.name)}</p><p class="route-meta">${escapeHTML(viewing.time)} · ${escapeHTML(viewing.meetingPlace)}</p></div></li>`;
              }).join("")}
            </ol></div>
          </section>` : ""}
        <section class="section" aria-labelledby="viewing-list-heading">
          <div class="section-heading"><h2 id="viewing-list-heading" class="section-title">${runtime.viewingRange === "today" ? "今日" : "今週"}の予定</h2></div>
          ${filtered.map(renderViewingCard).join("") || `<div class="empty-state" style="min-height:260px"><div class="empty-state-inner"><div class="empty-icon">⌖</div><h3 class="empty-title">内見予定はありません</h3></div></div>`}
        </section>
      </section>`;
  }

  function renderViewingCard(viewing) {
    const customer = customerById(viewing.customerId);
    const property = propertyById(viewing.propertyId);
    const linkedCase = Case.find((item) => item.customerId === viewing.customerId && item.propertyId === viewing.propertyId);
    const alreadyApplying = linkedCase && stageAtOrBeyond(linkedCase.stage, "申込準備");
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(viewing.meetingPlace)}`;
    return `<article class="card viewing-card">
      <div class="card-body">
        <div class="viewing-head">
          <time class="viewing-time">${escapeHTML(viewing.time)}<small>${escapeHTML(viewing.date)}</small></time>
          <div class="viewing-main"><div class="row" style="gap:6px;flex-wrap:wrap"><span class="status-pill ${viewing.status === "確定" ? "success" : "warning"}">${escapeHTML(viewing.status)}</span>${viewing.impression ? '<span class="status-pill neutral">感想あり</span>' : ""}</div><h3 class="card-title" style="margin-top:7px">${escapeHTML(property.name)}</h3><p class="person-meta">${escapeHTML(customer.name)}</p></div>
        </div>
        <div class="check-grid">
          <button class="check-button ${viewing.vacancyConfirmed ? "done" : ""}" type="button" data-action="toggle-vacancy" data-id="${viewing.id}"><span class="check-mark" aria-hidden="true">${viewing.vacancyConfirmed ? "✓" : ""}</span><span>空室再確認<br /><small>${viewing.vacancyConfirmed ? "確認済み" : "要確認"}</small></span></button>
          <button class="check-button ${viewing.keyConfirmed ? "done" : ""}" type="button" data-action="toggle-key" data-id="${viewing.id}"><span class="check-mark" aria-hidden="true">${viewing.keyConfirmed ? "✓" : ""}</span><span>鍵確認 <span class="internal-badge">社内限定</span><br /><small>${viewing.keyConfirmed ? "確認済み" : "要確認"}</small></span></button>
        </div>
        <p class="tiny-copy" style="margin-top:8px">鍵メモ：${escapeHTML(viewing.keyNote)}</p>
        <div class="meeting-box"><div><span class="detail-label">集合場所</span><strong class="detail-value">${escapeHTML(viewing.meetingPlace)}</strong></div><a class="maps-link" href="${mapsUrl}" target="_blank" rel="noreferrer" aria-label="${escapeHTML(viewing.meetingPlace)}をMapsで開く">Maps</a></div>
        <div class="card-actions"><button class="ghost-button" type="button" data-action="open-feedback" data-id="${viewing.id}">感想入力</button><button class="primary-button" type="button" data-action="start-application" data-id="${viewing.id}">${alreadyApplying ? `${escapeHTML(linkedCase.stage)}の案件を見る` : "申込へ進む"}</button></div>
      </div>
    </article>`;
  }

  function renderCases() {
    const stages = [
      ["追客中", "#80a995"],
      ["内見調整", "#f3a36f"],
      ["申込準備", "#d99655"],
      ["審査中", "#8e93c8"],
      ["契約準備", "#6da9ba"],
      ["契約済", "#6a9f83"],
    ];
    return `
      <section class="view" aria-labelledby="cases-title">
        <header class="view-header"><div><p class="eyebrow">DEAL PIPELINE</p><h1 id="cases-title" class="page-title">案件</h1></div><span class="date-chip">全 ${Case.length}件</span></header>
        <div class="summary-grid" aria-label="案件概要"><div class="metric-card"><span class="metric-label">期限24時間以内</span><strong class="metric-value">${Case.filter((item) => { const due = Date.parse(item.dueAt); return Number.isFinite(due) && due >= MOCK_NOW && due <= MOCK_NOW + 24 * 60 * 60 * 1_000; }).length}<span class="metric-unit">件</span></strong></div><div class="metric-card"><span class="metric-label">申込以降</span><strong class="metric-value">${Case.filter((item) => stageAtOrBeyond(item.stage, "申込準備")).length}<span class="metric-unit">件</span></strong></div></div>
        <section class="section" aria-labelledby="pipeline-heading">
          <div class="section-heading"><h2 id="pipeline-heading" class="section-title">ステージ別</h2><span class="section-note">縦に進行</span></div>
          ${stages.map(([stage, color], index) => {
            const cases = Case.filter((item) => item.stage === stage);
            return `<details class="stage-accordion" style="--stage-color:${color}" ${index === 1 ? "open" : ""}>
              <summary class="stage-summary"><span class="stage-rail-mark" aria-hidden="true"></span><span class="stage-summary-main"><span class="stage-name">${stage}</span><span class="stage-count">${cases.length}件</span></span><span class="stage-toggle" aria-hidden="true">＋</span></summary>
              <div class="stage-content">${cases.map(renderCaseCard).join("") || '<p class="small-copy">このステージの案件はありません。</p>'}</div>
            </details>`;
          }).join("")}
        </section>
      </section>`;
  }

  function renderCaseCard(caseItem) {
    const customer = customerById(caseItem.customerId);
    const property = propertyById(caseItem.propertyId);
    const dueLabel = dueCalendarLabel(caseItem.dueAt);
    const dueTimestamp = Date.parse(caseItem.dueAt);
    const urgent = Number.isFinite(dueTimestamp) && dueTimestamp <= MOCK_NOW + 24 * 60 * 60 * 1_000;
    return `<article class="case-card">
      <div class="case-line"><p class="case-customer">${escapeHTML(customer.name)}</p><span class="status-pill ${urgent ? "urgent" : "neutral"}">${escapeHTML(dueLabel)}</span></div>
      <p class="case-property">${escapeHTML(property.name)}</p>
      <div class="case-next"><span class="case-next-label">次アクション</span><strong class="case-next-action">${escapeHTML(caseItem.nextAction)}</strong></div>
      <div class="case-status-grid"><div class="case-status"><span class="status-label">書類</span><strong class="status-value">${escapeHTML(caseItem.documentStatus)}</strong></div><div class="case-status"><span class="status-label">申込状態</span><strong class="status-value">${escapeHTML(caseItem.applicationStatus)}</strong></div></div>
      <p class="case-history">履歴：${escapeHTML(dueCalendarLabel(caseItem.updatedAt))} · 佐藤が更新</p>
    </article>`;
  }

  function openSheet(content, labelId) {
    runtime.previousFocus = document.activeElement;
    modalRoot.innerHTML = `<div class="overlay"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="${labelId}"><div class="sheet-handle" aria-hidden="true"></div>${content}</section></div>`;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => modalRoot.querySelector("button, input, textarea, select")?.focus());
  }

  function closeModal() {
    if (!modalRoot.innerHTML) return;
    modalRoot.innerHTML = "";
    document.body.style.overflow = "";
    if (runtime.previousFocus instanceof HTMLElement && runtime.previousFocus.isConnected) runtime.previousFocus.focus();
    runtime.previousFocus = null;
    runtime.preferenceDraft = null;
  }

  function openCustomerDetail(customerId) {
    const customer = customerById(customerId);
    if (!customer) return;
    const condition = SearchCondition.find((item) => item.id === customer.searchConditionId);
    const liked = candidateIdsForCustomer(customer.id).map(propertyById).filter(Boolean);
    const statusLabels = { confirmed: "確定", inferred: "AI推定", unknown: "未確認" };
    const content = `
      <header class="sheet-header"><div><p class="eyebrow">CUSTOMER DETAIL</p><h2 id="customer-detail-title" class="sheet-title">${escapeHTML(customer.name)}</h2><p class="sheet-subtitle">${escapeHTML(customer.status)} · 担当 ${escapeHTML(customer.assignedTo || "未割当")}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
      <div class="sheet-content">
        <section class="detail-section" aria-labelledby="condition-section-title"><div class="detail-section-head"><h3 id="condition-section-title" class="detail-section-title">AI条件整理</h3><span class="mini-badge">確定 / 推定 / 未確認</span></div><ul class="condition-list">${condition.items.map((item) => `<li class="condition-item"><span class="condition-dot ${item.status}" aria-hidden="true"></span><div><p class="condition-title">${escapeHTML(item.label)} <span class="tag ${item.status === "confirmed" ? "success" : item.status === "inferred" ? "warning" : "neutral"}">${statusLabels[item.status]}</span></p><p class="condition-copy">${escapeHTML(item.value)}</p></div></li>`).join("")}</ul></section>
        <section class="detail-section" aria-labelledby="line-summary-title"><div class="detail-section-head"><h3 id="line-summary-title" class="detail-section-title">LINE会話と要約</h3><span class="mini-badge">会話から要約</span></div><blockquote class="summary-quote">${escapeHTML(customer.lineSummary)}</blockquote><ol class="conversation-list"><li><time>09:42</time><span>顧客</span><p>ありがとうございます。日当たりも重視したいです。</p></li><li><time>09:48</time><span>営業</span><p>承知しました。仕事スペースも含めて候補を整理します。</p></li><li><time>10:05</time><span>顧客</span><p>週末の午前なら内見できます。</p></li></ol></section>
        <section class="detail-section" aria-labelledby="liked-title"><div class="detail-section-head"><h3 id="liked-title" class="detail-section-title">Like物件</h3><span class="count-badge">${liked.length}</span></div>${liked.length ? `<ul class="liked-list">${liked.slice(0, 3).map((property) => { const candidate = candidateByIds(customer.id, property.id); return `<li class="liked-item"><span class="liked-thumb"><img src="${escapeHTML(property.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span><div class="person-main"><p class="person-name">${escapeHTML(property.name)}</p><p class="person-meta">${yen(property.rentYen)} · 一致率 ${clampPercent(candidate?.matchScore)}%</p></div></li>`; }).join("")}</ul>` : '<p class="small-copy">まだLikeした物件はありません。</p>'}</section>
        <section class="detail-section" aria-labelledby="progress-title"><div class="detail-section-head"><h3 id="progress-title" class="detail-section-title">進捗</h3><span class="stage-pill">${escapeHTML(customer.status)}</span></div><div class="progress-track" aria-label="進捗 ${clampPercent(customer.progress)}%"><div class="progress-value" style="width:${clampPercent(customer.progress)}%"></div></div><div class="progress-labels"><span>初回対応</span><span>物件提案</span><span>内見</span><span>申込</span><span>契約</span></div></section>
      </div>
      <footer class="sheet-footer">
        ${customer.unassigned ? `<button class="ghost-button" type="button" data-action="claim-customer" data-id="${customer.id}">担当になる</button>` : `<button class="ghost-button" type="button" data-action="close-modal">閉じる</button>`}
        <button class="primary-button" type="button" data-action="select-customer" data-id="${customer.id}">${state.selectedCustomerId === customer.id ? "選択中 · 物件を見る" : "この顧客で物件を見る"}</button>
      </footer>`;
    openSheet(content, "customer-detail-title");
  }

  function openPreferenceEditor(type, focusId = null) {
    const isProperty = type === "propertyFields";
    const validKeys = isProperty ? PROPERTY_FIELD_KEYS : WIDGET_KEYS;
    const available = isProperty ? DisplayPreference.availablePropertyFields : DisplayPreference.availableWidgets;
    if (!runtime.preferenceDraft || runtime.preferenceDraft.type !== type) {
      const enabled = new Set(state.displayPreference[type]);
      runtime.preferenceDraft = {
        type,
        order: [...state.displayPreference[type], ...validKeys.filter((key) => !enabled.has(key))],
        enabled,
      };
    }
    const draft = runtime.preferenceDraft;
    const content = `
      <form id="preference-form" data-preference="${type}">
        <header class="sheet-header"><div><p class="eyebrow">DISPLAY SETTINGS</p><h2 id="preference-title" class="sheet-title">${isProperty ? "物件カードの表示を編集" : "今日の表示を編集"}</h2><p class="sheet-subtitle">表示の有無と順番を営業ごとに保存します</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content"><div class="checkbox-list">${draft.order.map((itemId, index) => {
          const item = available.find((candidate) => candidate.id === itemId);
          return `<div class="checkbox-card"><label class="preference-check"><input type="checkbox" name="preference-item" value="${item.id}" ${draft.enabled.has(item.id) ? "checked" : ""} /><span class="checkbox-main"><span class="checkbox-title">${escapeHTML(item.label)}</span><span class="checkbox-copy">${escapeHTML(item.description)}</span></span></label><span class="order-controls"><button class="order-button" type="button" data-action="move-preference" data-id="${item.id}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="${escapeHTML(item.label)}を上へ">↑</button><button class="order-button" type="button" data-action="move-preference" data-id="${item.id}" data-direction="1" ${index === draft.order.length - 1 ? "disabled" : ""} aria-label="${escapeHTML(item.label)}を下へ">↓</button></span></div>`;
        }).join("")}</div></div>
        <footer class="sheet-footer"><button class="ghost-button" type="button" data-action="close-modal">キャンセル</button><button class="primary-button" type="submit">表示を保存</button></footer>
      </form>`;
    const openSheetElement = modalRoot.querySelector(".sheet");
    if (openSheetElement) {
      openSheetElement.innerHTML = `<div class="sheet-handle" aria-hidden="true"></div>${content}`;
    } else {
      openSheet(content, "preference-title");
    }
    if (focusId) {
      window.requestAnimationFrame(() => modalRoot.querySelector(`[data-action="move-preference"][data-id="${CSS.escape(focusId)}"]`)?.focus());
    }
  }

  function openReplyDraft() {
    const sent = runtime.sentReplies.get("c2");
    if (sent) {
      const content = `
        <header class="sheet-header"><div><p class="eyebrow">APPROVED REPLY</p><h2 id="reply-title" class="sheet-title">送信記録</h2><p class="sheet-subtitle">石井 健太さん · 営業確認済み</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content"><div class="reply-safety success-safety">営業が確認した本文だけをモック送信記録へ保存しています。</div><div class="reply-box"><p class="small-copy">${escapeHTML(sent.body)}</p></div><p class="tiny-copy">承認者 ${escapeHTML(sent.approvedBy)} · ${escapeHTML(sent.approvedAt)}</p></div>
        <footer class="sheet-footer single"><button class="ghost-button" type="button" data-action="close-modal">閉じる</button></footer>`;
      openSheet(content, "reply-title");
      return;
    }
    const content = `
      <form id="reply-form">
        <header class="sheet-header"><div><p class="eyebrow">AI REPLY DRAFT</p><h2 id="reply-title" class="sheet-title">返信案を確認</h2><p class="sheet-subtitle">石井 健太さんへの初回返信</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content">
          <div class="reply-safety">AIは自動送信しません。機密情報・社内限定情報は返信案に含めません。</div>
          <div class="reply-box"><div class="reply-meta"><span class="mini-badge">AI下書き</span><span class="tiny-copy">送信前に必ず確認</span></div><label class="form-group"><span class="form-label">返信内容</span><textarea class="form-textarea" name="reply">石井さま、お問い合わせありがとうございます。ご入居希望の時期に合うお部屋をお探しします。通勤先の最寄り駅と、ご希望の賃料上限を教えていただけますか？</textarea></label></div>
          <p class="small-copy">内容を修正できます。「確認して送信」を押すまで送信されません。</p>
        </div>
        <footer class="sheet-footer"><button class="ghost-button" type="button" data-action="close-modal">あとで確認</button><button class="primary-button" type="submit">確認して送信</button></footer>
      </form>`;
    openSheet(content, "reply-title");
  }

  function openFeedback(viewingId) {
    const viewing = Viewing.find((item) => item.id === viewingId);
    if (!viewing) return;
    const customer = customerById(viewing.customerId);
    const property = propertyById(viewing.propertyId);
    const content = `
      <form id="feedback-form" data-id="${viewing.id}">
        <header class="sheet-header"><div><p class="eyebrow">VIEWING FEEDBACK</p><h2 id="feedback-title" class="sheet-title">内見の感想</h2><p class="sheet-subtitle">${escapeHTML(customer.name)} · ${escapeHTML(property.name)}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="閉じる">×</button></header>
        <div class="sheet-content">
          <label class="form-group"><span class="form-label">温度感</span><select class="form-select" name="temperature">${["前向き", "比較検討", "見送り"].map((value) => `<option ${viewing.temperature === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
          <label class="form-group"><span class="form-label">感想・気になった点</span><textarea class="form-textarea" name="impression" placeholder="日当たりが良い、収納が少ないなど">${escapeHTML(viewing.impression)}</textarea></label>
          <label class="form-group"><span class="form-label">次のアクション</span><select class="form-select" name="next">${["申込へ進む", "ほかの物件を提案", "条件を見直す", "追客予定を入れる"].map((value) => `<option ${viewing.nextAction === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
        </div>
        <footer class="sheet-footer"><button class="ghost-button" type="submit" data-submit-mode="save">感想を保存</button><button class="primary-button" type="submit" data-submit-mode="apply">申込へ進む</button></footer>
      </form>`;
    openSheet(content, "feedback-title");
  }

  function commitPropertyDecision(action, propertyId, customerId) {
    const customer = customerById(customerId);
    const property = propertyById(propertyId);
    if (!customer || !property || !["liked", "skipped"].includes(action)) {
      runtime.decisionPending = false;
      return;
    }
    if (action === "liked" && property.listingStatus === "募集終了") {
      runtime.decisionPending = false;
      renderApp();
      showToast("募集終了のため候補へ保存できません");
      return;
    }
    const result = applyPropertyDecision(state.decisions, customer.id, property.id, action);
    state.decisions = result.decisions;
    runtime.undo = result.undo;
    runtime.decisionPending = false;
    const saved = persistState();
    renderApp({ focusSelector: '[data-action="property-like"]' });
    showUndoToast(property, action, { storageFailed: !saved });
  }

  function animatePropertyDecision(action, propertyId) {
    if (runtime.decisionPending) return;
    const customerId = state.selectedCustomerId;
    if (!customerId) return;
    runtime.decisionPending = true;
    const card = document.querySelector(`.top-card[data-property-id="${CSS.escape(propertyId)}"]`);
    if (!card) {
      commitPropertyDecision(action, propertyId, customerId);
      return;
    }
    card.classList.add(action === "liked" ? "is-exiting-like" : "is-exiting-skip");
    window.setTimeout(() => commitPropertyDecision(action, propertyId, customerId), REDUCED_MOTION.matches ? 0 : 190);
  }

  function undoLastDecision() {
    const undo = runtime.undo;
    if (!undo) return;
    const result = undoPropertyDecision(state.decisions, undo);
    if (!result.restored) return;
    state.decisions = result.decisions;
    clearUndoToast();
    const saved = persistState();
    if (state.activeTab === "properties") renderApp({ focusSelector: '[data-action="property-like"]' });
    showToast(saved ? "直前の判断を元に戻しました" : "元に戻しましたが、端末へ保存できませんでした");
  }

  function attachSwipeInteractions() {
    const card = appView.querySelector(".top-card[data-property-card]");
    if (!card) return;
    const stack = card.closest(".property-stack");
    const syncStackHeight = () => {
      if (stack?.isConnected && card.isConnected) {
        stack.style.height = `${Math.max(620, Math.ceil(card.getBoundingClientRect().height + 28))}px`;
      }
    };
    window.requestAnimationFrame(syncStackHeight);
    if (typeof ResizeObserver === "function") {
      runtime.propertyStackObserver = new ResizeObserver(syncStackHeight);
      runtime.propertyStackObserver.observe(card);
    }
    let gesture = null;

    const resetCard = () => {
      card.classList.remove("is-dragging");
      card.style.removeProperty("--drag-x");
      card.style.removeProperty("--drag-rotation");
      card.querySelectorAll(".swipe-badge").forEach((badge) => {
        badge.style.opacity = "0";
      });
    };

    card.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || gesture || runtime.decisionPending) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: event.timeStamp,
        dx: 0,
        axis: null,
        lastX: event.clientX,
        lastTime: event.timeStamp,
        velocityX: 0,
      };
    });

    card.addEventListener("pointermove", (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (!gesture.axis && Math.max(absX, absY) >= 8) {
        if (absX >= absY * 1.3) gesture.axis = "horizontal";
        else if (absY >= absX * 1.3) gesture.axis = "vertical";
        else if (Math.max(absX, absY) < 16) return;
        else gesture.axis = absX > absY ? "horizontal" : "vertical";
        if (gesture.axis === "horizontal") {
          card.setPointerCapture?.(event.pointerId);
          card.classList.add("is-dragging");
        }
      }
      if (gesture.axis !== "horizontal") return;
      event.preventDefault();
      gesture.dx = dx;
      const segmentTime = Math.max(1, event.timeStamp - gesture.lastTime);
      gesture.velocityX = (event.clientX - gesture.lastX) / segmentTime;
      gesture.lastX = event.clientX;
      gesture.lastTime = event.timeStamp;
      const width = Math.max(card.getBoundingClientRect().width, 1);
      const rotation = Math.max(-8, Math.min(8, (dx / width) * 8));
      const progress = Math.min(1, Math.abs(dx) / (width * 0.28));
      card.style.setProperty("--drag-x", `${dx}px`);
      card.style.setProperty("--drag-rotation", `${rotation}deg`);
      card.querySelector(".swipe-badge.like").style.opacity = dx > 0 ? String(progress) : "0";
      card.querySelector(".swipe-badge.skip").style.opacity = dx < 0 ? String(progress) : "0";
    });

    const finish = (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const current = gesture;
      gesture = null;
      if (current.axis !== "horizontal") {
        resetCard();
        return;
      }
      const width = Math.max(card.getBoundingClientRect().width, 1);
      current.dx = event.clientX - current.startX;
      const elapsed = Math.max(16, event.timeStamp - current.startTime);
      const averageSpeed = Math.abs(current.dx) / elapsed;
      const velocityMatchesDirection = Math.sign(current.velocityX) === Math.sign(current.dx);
      const speed = Math.max(averageSpeed, velocityMatchesDirection ? Math.abs(current.velocityX) : 0);
      const passedDistance = Math.abs(current.dx) >= width * 0.28;
      const passedSpeed = speed >= 0.55 && Math.abs(current.dx) >= 22;
      if (passedDistance || passedSpeed) {
        if (current.dx > 0 && card.dataset.listingStatus === "募集終了") {
          resetCard();
          showToast("募集終了のため候補へ保存できません");
          return;
        }
        animatePropertyDecision(current.dx > 0 ? "liked" : "skipped", card.dataset.propertyId);
      } else {
        resetCard();
      }
    };

    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", (event) => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture = null;
      resetCard();
    });
  }

  function moveViewingToApplication(viewingId) {
    const viewing = Viewing.find((item) => item.id === viewingId);
    if (!viewing) return;
    let caseItem = Case.find((item) => item.customerId === viewing.customerId && item.propertyId === viewing.propertyId);
    if (caseItem && !isKnownCaseStage(caseItem.stage)) {
      closeModal();
      showToast("案件ステージを確認してから申込へ進めてください");
      return;
    }
    if (caseItem && stageAtOrBeyond(caseItem.stage, "申込準備")) {
      closeModal();
      state.activeTab = "cases";
      persistState();
      renderApp({ focusMain: true });
      showToast(`${caseItem.stage}の案件を表示しました`);
      return;
    }
    if (caseItem) {
      caseItem.stage = "申込準備";
      caseItem.nextAction = "申込情報を入力";
      caseItem.applicationStatus = "入力待ち";
    } else {
      caseItem = {
        id: `case${Case.length + 1}`,
        customerId: viewing.customerId,
        propertyId: viewing.propertyId,
        stage: "申込準備",
        nextAction: "申込情報を入力",
        dueAt: "2026-08-12T12:00:00+09:00",
        documentStatus: "本人確認書類 待ち",
        applicationStatus: "入力待ち",
        updatedAt: "2026-08-11T11:20:00+09:00",
      };
      Case.push(caseItem);
    }
    const customer = customerById(viewing.customerId);
    if (customer) {
      customer.status = "申込済";
      customer.stage = "申込準備";
      customer.progress = Math.max(customer.progress, 72);
    }
    viewing.status = "申込へ進行";
    caseItem.updatedAt = "2026-08-11T11:20:00+09:00";
    closeModal();
    state.activeTab = "cases";
    persistState();
    renderApp({ focusMain: true });
    showToast("申込準備へ進めました（モック）");
  }

  document.addEventListener("click", (event) => {
    if (event.target.classList.contains("overlay")) {
      closeModal();
      return;
    }
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      setActiveTab(tab);
      return;
    }
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const { action, id, filter, range } = control.dataset;

    if (action === "close-modal") closeModal();
    if (action === "edit-preference") openPreferenceEditor(control.dataset.preference || "widgets");
    if (action === "move-preference" && runtime.preferenceDraft) {
      runtime.preferenceDraft.order = moveItem(runtime.preferenceDraft.order, id, Number(control.dataset.direction));
      openPreferenceEditor(runtime.preferenceDraft.type, id);
    }
    if (action === "open-reply") openReplyDraft();
    if (action === "open-customer") openCustomerDetail(id);
    if (action === "review-candidates") openCustomerDetail(id);
    if (action === "go-customers") setActiveTab("customers");
    if (action === "customer-filter") {
      runtime.customerFilter = filter;
      renderApp({ focusSelector: `[data-action="customer-filter"][data-filter="${CSS.escape(filter)}"]` });
    }
    if (action === "claim-customer") {
      const customer = customerById(id);
      if (customer) {
        customer.unassigned = false;
        customer.assignedTo = "佐藤";
        renderApp();
        openCustomerDetail(customer.id);
        showToast(`${customer.name}さんの担当になりました`);
      }
    }
    if (action === "select-customer") {
      if (runtime.undo) clearUndoToast();
      state.selectedCustomerId = id;
      state.activeTab = "properties";
      const saved = persistState();
      closeModal();
      renderApp({ focusMain: true });
      if (!saved) showToast("選択した顧客をこの端末へ保存できませんでした");
    }
    if (action === "complete-today-action") {
      const todayAction = TodayAction.find((item) => item.id === id);
      if (todayAction && (todayAction.id === "ta2" || todayAction.id === "ta6") && isTodayActionDone(todayAction)) {
        showToast(todayAction.id === "ta2" ? "送信済みの返信は未完了へ戻せません" : "担当取得済みです");
        return;
      }
      if (runtime.completedTodayActions.has(id)) runtime.completedTodayActions.delete(id);
      else runtime.completedTodayActions.add(id);
      renderApp({ focusSelector: `[data-action="complete-today-action"][data-id="${CSS.escape(id)}"]` });
      showToast(runtime.completedTodayActions.has(id) ? "完了にしました" : "未完了に戻しました");
    }
    if (action === "property-like") animatePropertyDecision("liked", id);
    if (action === "property-skip") animatePropertyDecision("skipped", id);
    if (action === "undo-decision") undoLastDecision();
    if (action === "relax-condition") {
      const customer = customerById(state.selectedCustomerId);
      if (!customer) return;
      const decisions = decisionRecord(customer.id);
      if (decisions.skipped.length) {
        if (runtime.undo) clearUndoToast();
        decisions.skipped = [];
        const saved = persistState();
        renderApp({ focusSelector: '[data-action="property-like"]' });
        showToast(saved ? "Skipした物件を未確認へ戻しました" : "未確認へ戻しましたが、端末へ保存できませんでした");
      } else {
        showToast("保存済み候補は維持されています");
      }
    }
    if (action === "retry-property-search") {
      showToast("駅徒歩・築年数の緩和案です。条件編集はITANDI接続工程で有効になります");
    }
    if (action === "viewing-range") {
      runtime.viewingRange = range;
      renderApp({ focusSelector: `[data-action="viewing-range"][data-range="${CSS.escape(range)}"]` });
    }
    if (action === "toggle-vacancy" || action === "toggle-key") {
      const viewing = Viewing.find((item) => item.id === id);
      if (viewing) {
        if (action === "toggle-vacancy") viewing.vacancyConfirmed = !viewing.vacancyConfirmed;
        else viewing.keyConfirmed = !viewing.keyConfirmed;
        renderApp({ focusSelector: `[data-action="${CSS.escape(action)}"][data-id="${CSS.escape(id)}"]` });
        showToast(action === "toggle-vacancy" ? "空室確認を更新しました" : "鍵確認を更新しました（社内限定）");
      }
    }
    if (action === "open-feedback") openFeedback(id);
    if (action === "start-application") moveViewingToApplication(id);
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "customer-search") return;
    runtime.customerSearch = event.target.value;
    refreshCustomerResults();
  });

  document.addEventListener("change", (event) => {
    if (event.target.name !== "preference-item" || !runtime.preferenceDraft) return;
    if (event.target.checked) runtime.preferenceDraft.enabled.add(event.target.value);
    else runtime.preferenceDraft.enabled.delete(event.target.value);
  });

  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "preference-form" && runtime.preferenceDraft) {
      const draft = runtime.preferenceDraft;
      const validKeys = draft.type === "propertyFields" ? PROPERTY_FIELD_KEYS : WIDGET_KEYS;
      const selected = draft.order.filter((item) => draft.enabled.has(item) && validKeys.includes(item));
      if (!selected.length) {
        showToast("1つ以上の表示項目を選んでください");
        return;
      }
      state.displayPreference[draft.type] = selected;
      const preferenceType = draft.type;
      const saved = persistState();
      closeModal();
      renderApp({ focusSelector: `[data-action="edit-preference"][data-preference="${preferenceType}"]` });
      showToast(saved ? "表示と順番を保存しました" : "表示を変更しましたが、端末へ保存できませんでした");
    }
    if (event.target.id === "reply-form") {
      if (runtime.replyPending) return;
      const formData = new FormData(event.target);
      const body = String(formData.get("reply") || "").trim();
      if (!body) {
        showToast("返信本文を入力してください");
        event.target.elements.reply?.focus();
        return;
      }
      if (containsInternalFragment(body, INTERNAL_REPLY_FRAGMENTS)) {
        showToast("鍵・AD・管理会社メモなどの社内限定情報を削除してください");
        event.target.elements.reply?.focus();
        return;
      }
      let approvedReply;
      runtime.replyPending = true;
      try {
        const draftId = "reply-c2-initial-v1";
        const approval = createMockReplyApproval({
          draftId,
          body,
          approvedBy: "employee:sato",
        });
        approvedReply = createApprovedReplyDTO({ customerId: "c2", draftId, body, approval });
        approvedReply = await replyGateway.sendApprovedReply(approvedReply);
      } catch (error) {
        runtime.replyPending = false;
        showToast(error.message || "返信内容を確認してください");
        return;
      }
      runtime.replyPending = false;
      runtime.sentReplies.set("c2", approvedReply);
      closeModal();
      runtime.completedTodayActions.add("ta2");
      renderApp({ focusSelector: '[data-action="open-reply"]' });
      showToast("確認済みの返信を送信しました（モック）");
    }
    if (event.target.id === "feedback-form") {
      const viewing = Viewing.find((item) => item.id === event.target.dataset.id);
      if (!viewing) return;
      const formData = new FormData(event.target);
      viewing.impression = String(formData.get("impression") || "").trim();
      viewing.temperature = String(formData.get("temperature") || "比較検討");
      viewing.nextAction = String(formData.get("next") || "追客予定を入れる");
      const mode = event.submitter?.dataset.submitMode || "save";
      if (mode === "apply") moveViewingToApplication(viewing.id);
      else {
        closeModal();
        renderApp({ focusSelector: `[data-action="open-feedback"][data-id="${viewing.id}"]` });
        showToast("内見の感想を保存しました");
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalRoot.innerHTML) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab" || !modalRoot.innerHTML) return;
    const focusable = [...modalRoot.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  renderApp();
})();
