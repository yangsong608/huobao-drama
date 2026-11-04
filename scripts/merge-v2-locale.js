// 一次性脚本：把 V2 收口新增文案合并进 4 语言包
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '../frontend/app/locales')
const additions = {
  zh: {
    common: { edit: '编辑' },
    detail: { ep: { dub: '配音' } },
    voiceProfile: { sampled: '试听已生成' },
    grid: {
      entry: '宫格图', entryTitle: '用一张宫格图批量产出同风格素材图',
      title: '宫格图生成与校正', desc: '一次生成多格同风格素材图，切分后可校正坐标并应用到角色/场景/道具',
      kind: '素材类型', layout: '宫格布局', inset: '内缩比例', insetHint: '0–0.2，默认 0.015，避免把分隔线切进画面',
      targets: '提示词顺序（按选中顺序）', targetsHint: '生成时会把名称按顺序写进提示词；切分后可逐格绑定素材',
      noTargets: '当前类型暂无素材', prompt: '补充提示词', promptPlaceholder: '可选：补充画风、光线、时代质感等',
      generate: '生成宫格图', regenerate: '重新生成', creating: '生成中…',
      statusProcessing: '图片生成中…', statusGenerated: '已生成，待切分', statusSplit: '已切分', statusFailed: '生成失败',
      apply: '应用到素材', applying: '应用中…', applied: '已设置素材图',
      pickTarget: '绑定到…', noTarget: '不绑定', pickTargetFirst: '请先选择要绑定的素材',
      rectTitle: '人工校正切分坐标', rectHint: '坐标为相对整图的 0–1 比例；保存后重新切分生效',
      resplit: '保存坐标并重切', splitting: '切分中…', rectSaved: '坐标已保存并重新切分',
      created: '宫格任务已创建', foot: '切分图会保存在项目 grid 目录',
    },
    scriptImport: {
      entry: '导入剧本', entryTitle: '整本剧本按章节拆集导入',
      title: '整本剧本导入', desc: '按标题正则分章，再按 1200 字左右在章节边界拆集，预览后一键建集',
      file: '剧本文件', pickFile: '选择文件', fileHint: '支持 .txt/.md，不超过 2MB',
      text: '或直接粘贴文本', placeholder: '粘贴整本小说/剧本正文…',
      charCount: '{n} 字', parse: '解析分章', parsing: '解析中…',
      summary: '共 {chapters} 章 → 预计 {episodes} 集', preview: '建集预览',
      reused: '复用解析记录', newImport: '新建解析记录',
      modeAppend: '追加建集', modeReplace: '替换已有集', replaceWarn: '替换会软删除当前项目已有的集，请确认！',
      autoPipeline: '建集后自动开始流水线', autoDub: '同时生成配音',
      commit: '确认建集', committing: '建集中…', committed: '已建 {n} 集',
      parsed: '解析完成', tooLarge: '文件不能超过 2MB', foot: '同一文本重复解析会复用记录，不会重复建集',
    },
    narrator: {
      entry: '旁白音色', entryTitle: '项目旁白音色：生成、编辑与试听',
      title: '旁白音色', desc: '全项目唯一一条旁白音色，未配音色的台词会回退到它',
      empty: '尚未生成旁白音色', emptyHint: '点击右上「生成」，由 LLM 产出声音提示词并合成试听',
      active: '已激活', inactive: '未激活', force: '强制重做',
      sampleReady: '试听已更新', foot: '设计上旁白不作为视频音色参考；克隆请在角色音色里操作',
    },
    delivery: {
      entry: '交付版本', title: '成片版本与交付', desc: '原片（拼接）/ 配音（混音）/ 图文动画三版本并存，可下载与回滚',
      refresh: '刷新', empty: '暂无成片版本，先生成视频并合并',
      renderMotion: '生成图文动画', rendering: '生成中…',
      renderHint: '用分镜图 + 推拉镜头 + 已有配音轨拼出可交付版本',
      renderConfirm: '用分镜图与配音生成「图文动画」版本？', renderDone: '图文动画版本已生成',
      kindConcat: '原片', kindMix: '配音', kindMotion: '图文', current: '当前使用',
      withSubtitle: '含字幕', play: '播放', download: '下载', setCurrent: '设为当前版本', switching: '切换中…',
      switched: '已切换成片版本', foot: '「设为当前版本」会把该版本写回集的成片地址',
    },
  },
  en: {
    common: { edit: 'Edit' },
    detail: { ep: { dub: 'Dub' } },
    voiceProfile: { sampled: 'Preview ready' },
    grid: {
      entry: 'Grid sheet', entryTitle: 'Generate multiple consistent asset images in one shot',
      title: 'Grid sheet & crop', desc: 'Generate a rows×cols grid, split it and fix crop boxes per cell',
      kind: 'Asset type', layout: 'Layout', inset: 'Inset ratio', insetHint: '0–0.2, default 0.015 to avoid cutting dividers',
      targets: 'Prompt order (by selection)', targetsHint: 'Names are written into the prompt in order; bind cells to assets after split',
      noTargets: 'No assets of this type', prompt: 'Extra prompt', promptPlaceholder: 'Optional: style, lighting, era...',
      generate: 'Generate', regenerate: 'Regenerate', creating: 'Creating...',
      statusProcessing: 'Generating...', statusGenerated: 'Ready to split', statusSplit: 'Split done', statusFailed: 'Failed',
      apply: 'Apply to asset', applying: 'Applying...', applied: 'Asset image updated',
      pickTarget: 'Bind to...', noTarget: 'No binding', pickTargetFirst: 'Pick an asset first',
      rectTitle: 'Manual crop boxes', rectHint: 'Relative 0–1 coordinates; saved boxes are used on next split',
      resplit: 'Save & split', splitting: 'Splitting...', rectSaved: 'Boxes saved and re-split',
      created: 'Grid task created', foot: 'Cell images are saved under the project grid folder',
    },
    scriptImport: {
      entry: 'Import script', entryTitle: 'Split a whole book into episodes',
      title: 'Import full script', desc: 'Chapter detection, ~1200-char episode splitting, preview then create',
      file: 'Script file', pickFile: 'Choose file', fileHint: '.txt/.md up to 2MB',
      text: 'Or paste text', placeholder: 'Paste the whole book...',
      charCount: '{n} chars', parse: 'Parse', parsing: 'Parsing...',
      summary: '{chapters} chapters -> ~{episodes} episodes', preview: 'Preview',
      reused: 'Reused parse', newImport: 'New parse',
      modeAppend: 'Append', modeReplace: 'Replace existing', replaceWarn: 'Replace soft-deletes existing episodes!',
      autoPipeline: 'Start pipeline after create', autoDub: 'Also generate dub',
      commit: 'Create episodes', committing: 'Creating...', committed: 'Created {n} episodes',
      parsed: 'Parsed', tooLarge: 'File larger than 2MB', foot: 'Re-parsing the same text reuses the record',
    },
    narrator: {
      entry: 'Narrator voice', entryTitle: 'Project narrator voice',
      title: 'Narrator voice', desc: 'One narrator voice per project; lines without a voice fall back to it',
      empty: 'No narrator voice yet', emptyHint: 'Click Generate to create the voice prompt and a sample',
      active: 'Active', inactive: 'Inactive', force: 'Force redo',
      sampleReady: 'Preview updated', foot: 'Narrator is not used as a video voice reference',
    },
    delivery: {
      entry: 'Versions', title: 'Delivery versions', desc: 'Original / dubbed / motion versions with download and rollback',
      refresh: 'Refresh', empty: 'No merged video yet',
      renderMotion: 'Build motion version', rendering: 'Rendering...',
      renderHint: 'Storyboard images + pan/zoom + existing dub track',
      renderConfirm: 'Build a motion-post version from storyboards and dub?', renderDone: 'Motion version ready',
      kindConcat: 'Original', kindMix: 'Dubbed', kindMotion: 'Motion', current: 'In use',
      withSubtitle: 'With subtitle', play: 'Play', download: 'Download', setCurrent: 'Use this version', switching: 'Switching...',
      switched: 'Version switched', foot: '"Use this version" writes it back to the episode video',
    },
  },
  ja: {
    common: { edit: '編集' },
    detail: { ep: { dub: '吹き替え' } },
    voiceProfile: { sampled: '試聴を更新しました' },
    grid: {
      entry: 'グリッド図', entryTitle: '1枚のグリッドで統一素材を一括生成',
      title: 'グリッド図の生成と切り出し', desc: '同じ画風の素材を一括生成し、切り出して座標を補正',
      kind: '素材タイプ', layout: 'レイアウト', inset: '内縮率', insetHint: '0–0.2、既定 0.015',
      targets: 'プロンプト順（選択順）', targetsHint: '生成後にセル単位で素材へ適用',
      noTargets: 'このタイプの素材がありません', prompt: '追加プロンプト', promptPlaceholder: '任意：画風・光・時代など',
      generate: '生成', regenerate: '再生成', creating: '生成中...',
      statusProcessing: '生成中...', statusGenerated: '切り出し待ち', statusSplit: '切り出し済', statusFailed: '失敗',
      apply: '素材に適用', applying: '適用中...', applied: '素材画像を更新しました',
      pickTarget: '紐付け先...', noTarget: '紐付けない', pickTargetFirst: '先に素材を選択してください',
      rectTitle: '切り出し座標の補正', rectHint: '0–1 の相対座標。保存後に再切り出し',
      resplit: '保存して再切り出し', splitting: '切り出し中...', rectSaved: '座標を保存して再切り出ししました',
      created: 'タスクを作成しました', foot: '画像はプロジェクトの grid に保存されます',
    },
    scriptImport: {
      entry: '脚本を導入', entryTitle: '全話脚本を章分割して導入',
      title: '脚本の一括導入', desc: '章タイトルを検出し、約1200字で話に分割して作成',
      file: '脚本ファイル', pickFile: 'ファイル選択', fileHint: '.txt/.md 2MBまで',
      text: 'または貼り付け', placeholder: '本文を貼り付け...',
      charCount: '{n} 文字', parse: '解析', parsing: '解析中...',
      summary: '{chapters} 章 → 約 {episodes} 話', preview: 'プレビュー',
      reused: '解析を再利用', newImport: '新規解析',
      modeAppend: '追加', modeReplace: '既存を置換', replaceWarn: '置換すると既存話が削除されます',
      autoPipeline: '作成後にパイプライン開始', autoDub: '吹き替えも生成',
      commit: '作成', committing: '作成中...', committed: '{n} 話を作成しました',
      parsed: '解析完了', tooLarge: '2MBを超えています', foot: '同じ本文の再解析は記録を再利用します',
    },
    narrator: {
      entry: 'ナレーション音声', entryTitle: 'プロジェクトのナレーション音声',
      title: 'ナレーション音声', desc: 'プロジェクトに1つ。未割当のセリフはこれにフォールバック',
      empty: '未生成です', emptyHint: '「生成」で音声プロンプトと試聴を作成',
      active: '有効', inactive: '無効', force: '強制再作成',
      sampleReady: '試聴を更新', foot: 'ナレーションは映像の音声参考には使いません',
    },
    delivery: {
      entry: '納品バージョン', title: '完成版と納品', desc: '原片 / 吹き替え / 画像アニメの3版をダウンロード・切り替え',
      refresh: '更新', empty: '完成版がありません',
      renderMotion: '画像アニメを生成', rendering: '生成中...',
      renderHint: '絵コンテ画像＋ズーム＋既存の吹き替えトラック',
      renderConfirm: '画像アニメ版を作成しますか？', renderDone: '画像アニメ版を作成しました',
      kindConcat: '原片', kindMix: '吹き替え', kindMotion: '画像アニメ', current: '使用中',
      withSubtitle: '字幕あり', play: '再生', download: 'ダウンロード', setCurrent: 'この版を使用', switching: '切替中...',
      switched: '版を切り替えました', foot: '「この版を使用」でこの成片が現在版になります',
    },
  },
  ko: {
    common: { edit: '편집' },
    detail: { ep: { dub: '더빙' } },
    voiceProfile: { sampled: '미리듣기 업데이트됨' },
    grid: {
      entry: '그리드 이미지', entryTitle: '한 장으로 같은 화풍 소재를 대량 생성',
      title: '그리드 생성 및 분할', desc: '같은 화풍 소재를 한 번에 생성하고 분할 후 좌표 보정',
      kind: '소재 유형', layout: '배치', inset: '안쪽 여백', insetHint: '0–0.2, 기본 0.015',
      targets: '프롬프트 순서(선택 순)', targetsHint: '생성 후 칸 단위로 소재에 적용',
      noTargets: '이 유형 소재가 없습니다', prompt: '추가 프롬프트', promptPlaceholder: '선택: 화풍/조명/시대 등',
      generate: '생성', regenerate: '다시 생성', creating: '생성 중...',
      statusProcessing: '생성 중...', statusGenerated: '분할 대기', statusSplit: '분할 완료', statusFailed: '실패',
      apply: '소재에 적용', applying: '적용 중...', applied: '소재 이미지가 변경되었습니다',
      pickTarget: '연결 대상...', noTarget: '연결 안 함', pickTargetFirst: '먼저 소재를 선택하세요',
      rectTitle: '분할 좌표 보정', rectHint: '0–1 상대 좌표, 저장 후 다시 분할',
      resplit: '저장 후 분할', splitting: '분할 중...', rectSaved: '좌표를 저장하고 다시 분할했습니다',
      created: '그리드 작업 생성됨', foot: '잘린 이미지는 프로젝트 grid 폴더에 저장됩니다',
    },
    scriptImport: {
      entry: '대본 가져오기', entryTitle: '전체 대본을 회차로 분할',
      title: '전체 대본 가져오기', desc: '제목 정규식으로 분할 후 약 1200자 단위로 회차 생성',
      file: '대본 파일', pickFile: '파일 선택', fileHint: '.txt/.md 2MB 이하',
      text: '또는 붙여넣기', placeholder: '본문 붙여넣기...',
      charCount: '{n}자', parse: '분석', parsing: '분석 중...',
      summary: '{chapters}장 → 약 {episodes}회', preview: '미리보기',
      reused: '기존 분석 재사용', newImport: '새 분석',
      modeAppend: '추가', modeReplace: '기존 교체', replaceWarn: '교체하면 기존 회차가 삭제됩니다!',
      autoPipeline: '생성 후 파이프라인 시작', autoDub: '더빙도 생성',
      commit: '회차 생성', committing: '생성 중...', committed: '{n}회 생성됨',
      parsed: '분석 완료', tooLarge: '2MB를 초과합니다', foot: '같은 본문은 분석을 재사용합니다',
    },
    narrator: {
      entry: '내레이션 음성', entryTitle: '프로젝트 내레이션 음성',
      title: '내레이션 음성', desc: '프로젝트에 하나뿐이며, 미할당 대사는 이 음성으로 대체됩니다',
      empty: '아직 없음', emptyHint: '생성 버튼으로 음성 프롬프트와 미리듣기를 만드세요',
      active: '활성', inactive: '비활성', force: '강제 재생성',
      sampleReady: '미리듣기 갱신됨', foot: '내레이션은 영상 음성 참고로 사용하지 않습니다',
    },
    delivery: {
      entry: '배포 버전', title: '완성본 버전과 배포', desc: '원본 / 더빙 / 이미지 애니 3개 버전 다운로드·전환',
      refresh: '새로고침', empty: '완성 영상이 없습니다',
      renderMotion: '이미지 애니 생성', rendering: '생성 중...',
      renderHint: '스토리보드 이미지 + 줌 + 기존 더빙 트랙',
      renderConfirm: '이미지 애니 버전을 만들까요?', renderDone: '이미지 애니 버전이 생성됐습니다',
      kindConcat: '원본', kindMix: '더빙', kindMotion: '이미지 애니', current: '사용 중',
      withSubtitle: '자막 포함', play: '재생', download: '다운로드', setCurrent: '이 버전 사용', switching: '전환 중...',
      switched: '버전이 전환되었습니다', foot: '이 버전 사용 시 이 영상이 현재 완성본이 됩니다',
    },
  },
}

function deepMerge(base, add) {
  for (const [key, value] of Object.entries(add)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!base[key] || typeof base[key] !== 'object') base[key] = {}
      deepMerge(base[key], value)
    } else {
      base[key] = value
    }
  }
}

for (const [lang, payload] of Object.entries(additions)) {
  const file = path.join(dir, `${lang}.json`)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  deepMerge(json, payload)
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log('updated', lang)
}
