// assets 能力段的路由定义（从 routes.ts 原样搬出；顺序即注册顺序）。
import { z } from '@hono/zod-openapi';
import {
  assetRevisionSchema,
  assetSchema
} from '@agent-hub/contract';
import { V1, json, body, route } from './base.ts';

export const assets = {
  listAssets: route('assets:read', {
    method: 'get', path: `${V1}/assets`, tags: ['assets'], summary: '我能用的资产',
    description:
      '列出令牌账号能看见的资产（全局、团队、可见项目、自己的个人资产）。\n' +
      '参数：kind（可选，skill / instruction / mcp）。\n' +
      '返回：资产数组（id、kind、name、scope、pinned/latest digest、描述）。\n' +
      '下一步：用 get_asset 看某个资产的版本；会话要用它就先给会话配资产集。\n' +
      '错误：401 令牌无效；403 无 assets:read。',
    request: { query: z.object({ kind: z.enum(['skill', 'instruction', 'mcp']).optional() }) },
    responses: { 200: json(z.array(assetSchema)) }
  }),
  getAsset: route('assets:read', {
    method: 'get', path: `${V1}/assets/{assetId}`, tags: ['assets'], summary: '看一个资产与它的版本',
    description:
      '按 id 看资产详情与版本列表（不含文件内容）。\n' +
      '参数：assetId（路径）。\n' +
      '返回：{ asset, revisions: [{ digest, commit, createdAt }] }。\n' +
      '下一步：要用某个版本就把 digest 记下来（会话资产集按 digest 钉）。\n' +
      '错误：401 令牌无效；404 资产不存在或你看不见。',
    request: { params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }) },
    responses: { 200: json(z.object({ asset: assetSchema, revisions: z.array(assetRevisionSchema) })) }
  }),
  createAsset: route('assets:write', {
    method: 'post', path: `${V1}/assets`, tags: ['assets'], summary: '新建资产（默认进审核）',
    description:
      '上传一个新资产（skill / instruction / mcp）。**默认只进审核队列**，审核通过后才可用于会话。\n' +
      '参数：kind、name（可选，不给自己推）、scope（personal/team/project）、projectId（scope=project 时必填）、publish（默认 false；true = 直接发布，要 assets:publish）、files（[{path, data(base64)}]，≤200 个、单文件 ≤1MB）。\n' +
      '返回：资产对象（pinned 为空表示还没发布）。\n' +
      '下一步：publish=false 时等审核；publish=true 时接着用 asset_assign 装到机器。用 get_asset 复核 pinned digest。\n' +
      '错误：400 文件不合法或超限；403 无 assets:write，或 publish=true 但没有 assets:publish；409 同范围同名已存在。',
    request: body(
      z.object({
        kind: z.enum(['skill', 'instruction', 'mcp']),
        name: z.string().max(64).nullable().optional(),
        scope: z.enum(['personal', 'team', 'project']).default('personal'),
        projectId: z.string().nullable().optional(),
        publish: z.boolean().default(false),
        files: z.array(z.object({ path: z.string().min(1).max(512), data: z.string() })).min(1).max(200)
      })
    ),
    responses: { 201: json(assetSchema, '已创建') }
  }, { module: 'assets', need: 'asset.submit', readOnly: false, expose: 'asset_create', idempotent: true }),
  importAsset: route('assets:write', {
    method: 'post', path: `${V1}/assets/import`, tags: ['assets'], summary: '从 Git 仓库导入资产（可选直接发布）',
    description:
      '从一个 Git 仓库导入 skill / instruction / mcp 资产。默认只建版本、进审核队列；publish=true 时直接发布（要 assets:publish）。\n' +
      '参数：kind、url（https 或 git 地址，可直接粘 GitHub 文件 / 目录网址）、ref（可选，分支 / 标签）、path（技能目录如 skills/foo，或指令 / mcp 文件如 AGENTS.md）、name（可选，不给自己推）、scope（personal/team/project）、projectId（scope=project 时必填）、publish（默认 false）。\n' +
      'policy：locked（默认，钉在导入时的提交上）或 track（跟随分支，可用 asset_check 看新提交）。\n' +
      'credential：私有仓库令牌，只用于这次拉取；policy=track 时服务端存进密钥箱供以后检查更新，永不回显。\n' +
      '返回：资产对象（pinned 为空表示还没发布；latest 是刚导入版本的 digest）。\n' +
      '下一步：publish=true 时已可直接用，用 asset_assign 装到机器；否则用 asset_publish 发布（要 assets:publish）或等审核。\n' +
      '错误：400 仓库读不出来、路径不存在或文件超限；403 无 assets:write，或 publish=true 但没有 assets:publish；409 同范围同名已存在。\n' +
      '重试：MCP 调用要给 clientRequestId，同一值重试返回同一份结果。',
    request: body(
      z.object({
        kind: z.enum(['skill', 'instruction', 'mcp']),
        url: z.string().min(1).max(512),
        ref: z.string().max(200).nullable().optional(),
        path: z.string().max(512).optional(),
        name: z.string().max(64).nullable().optional(),
        scope: z.enum(['personal', 'team', 'project']).default('personal'),
        projectId: z.string().nullable().optional(),
        publish: z.boolean().default(false),
        policy: z.enum(['track', 'locked']).optional(),
        credential: z.string().min(1).max(512).optional()
      })
    ),
    responses: { 201: json(assetSchema, '已导入') }
  }, { module: 'assets', need: 'asset.submit', readOnly: false, expose: 'asset_import', idempotent: true }),
  publishAsset: route('assets:publish', {
    method: 'post', path: `${V1}/assets/{assetId}/publish`, tags: ['assets'], summary: '发布资产的最新版本',
    description:
      '把资产的最新版本（latest）钉成线上版本（pinned），会话随即用上新版本。自动化路径，审计留痕。\n' +
      '参数：assetId（路径）。\n' +
      '返回：发布后的资产对象（pinned === latest）。\n' +
      '下一步：用 asset_assign 把它装到会话要用的机器上；用 get_asset 复核 pinned。\n' +
      '错误：403 无 assets:publish，或全局资产但不是集群管理员；404 资产不存在或看不见；409 latest 为空或已经发布（没有待发布的新版本）。',
    request: { params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }) },
    responses: { 200: json(assetSchema) }
  }, { module: 'assets', need: 'asset.review', readOnly: false, expose: 'asset_publish', idempotent: true }),
  assignAsset: route('assets:publish', {
    method: 'post', path: `${V1}/assets/{assetId}/workers`, tags: ['assets'], summary: '把资产装到机器上（或卸下）',
    description:
      '分配 / 取消分配：把资产装到某台机器（installed=true，默认）或从机器上卸下（false）。装好后这台机器上开的会话，资产集（resolveSessionAssets）就会带上它。\n' +
      '参数：assetId（路径）；workerId（机器 id，先 list_workers 看有哪些）；installed（默认 true）。\n' +
      '返回：{ assetId, workerId, installed }。\n' +
      '下一步：用 session_start 在这台机器上开会话，资产自动带上；用 get_asset 看钉住的 pinned 版本。\n' +
      '错误：403 无 assets:publish；404 资产或机器不存在 / 看不见。',
    request: {
      params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }),
      ...body(z.object({ workerId: z.string().min(1), installed: z.boolean().default(true) }))
    },
    responses: { 200: json(z.object({ assetId: z.string(), workerId: z.string(), installed: z.boolean() })) }
  }, { module: 'assets', need: 'asset.assign', readOnly: false, expose: 'asset_assign', idempotent: true }),
  listBuiltinAssets: route('assets:read', {
    method: 'get', path: `${V1}/builtin-assets`, tags: ['assets'], summary: '内置资产清单与项目启用状态',
    description:
      '列出 hub 自带的资产（Playwright 浏览器 MCP、web-testing 技能等）和它们在某个项目里的启用状态。\n' +
      '参数：projectId（必填）：看哪个项目的启用状态。\n' +
      '权限：assets:read 看清单本身；启用状态与项目设置页同门（要能改该项目，个人令牌要 projects:write + 项目权限），没有就 403。\n' +
      '下一步：用 enable_builtin_asset 把缺的启用；会话需要浏览器（requires browser:chromium）时 session_start 也会自动启用未配置的。\n' +
      '错误：401 令牌无效；403 无 assets:read，或看不到该项目设置；404 项目不存在。',
    request: { query: z.object({ projectId: z.string().min(1) }) },
    responses: {
      200: json(
        z.array(
          z.object({
            id: z.string(),
            kind: z.enum(['skill', 'instruction', 'mcp']),
            name: z.string(),
            title: z.string(),
            summary: z.string(),
            version: z.string(),
            source: z.object({ label: z.string(), url: z.string(), license: z.string() }),
            secrets: z.array(z.object({ name: z.string(), label: z.string(), set: z.boolean() }).passthrough()),
            requiresBrowser: z.boolean(),
            note: z.string().nullable(),
            pairsWith: z.array(z.string()),
            enabled: z.object({ assetId: z.string(), version: z.string(), on: z.boolean(), update: z.string().nullable() }).nullable(),
            clash: z.string().nullable()
          })
        ),
        '内置资产与该项目里的启用状态'
      )
    }
  }, { module: 'assets', need: 'asset.read', expose: 'list_builtin_assets' }),
  enableBuiltinAsset: route('assets:submit', {
    method: 'post', path: `${V1}/builtin-assets/{builtinId}/enable`, tags: ['assets'], summary: '给项目启用一项内置资产',
    description:
      '把 hub 自带资产（如 playwright 浏览器 MCP、web-testing 技能）启用到项目：与项目设置页同一条用例，不复制另一套。密钥缺了会 400 并点名要填哪些。\n' +
      '参数：builtinId（路径）；projectId（必填）；secrets（可选，{ 名字: 值 }，顺手存成团队密钥，只写不回）。\n' +
      '权限：assets:write + 能改该项目（个人令牌加 projects:write）。已启用的只把项目开关打开（created=false）；项目里已有同名的自己的资产时不覆盖（409）。\n' +
      '返回：{ asset, created }。\n' +
      '下一步：会话 requires browser:chromium 时资产自动带上；机器还没有该能力就用 capability_status 看，再 component_install 或 install_builtin_browser 装。\n' +
      '错误：400 内置资产需要密钥（点名）；403 无权限；404 项目或内置资产不存在；409 同名冲突。',
    request: {
      params: z.object({ builtinId: z.string().min(1).openapi({ param: { name: 'builtinId', in: 'path' } }) }),
      ...body(z.object({ projectId: z.string().min(1), secrets: z.record(z.string(), z.string()).optional() }))
    },
    responses: { 200: json(z.object({ asset: assetSchema, created: z.boolean() })) }
  }, { module: 'assets', need: 'asset.submit', readOnly: false, expose: 'enable_builtin_asset', idempotent: true }),
  submitAssetRevision: route('assets:submit', {
    method: 'post', path: `${V1}/assets/{assetId}/revisions`, tags: ['assets'], summary: '给资产交一个新版本（进审核）',
    description: '只有作者（或团队负责人）能交；新版本进待审队列，审核通过才上线。令牌默认不能审核、发布、装机或下架（除非显式给了 assets:publish）。文件内容 base64。',
    request: {
      params: z.object({ assetId: z.string().openapi({ param: { name: 'assetId', in: 'path' } }) }),
      ...body(z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), data: z.string() })).min(1).max(200) }))
    },
    responses: {
      200: json(z.object({ assetId: z.string(), latest: z.string(), submissionId: z.string().nullable(), status: z.string().nullable() }))
    }
  }, { skip: '交新版本进审核队列是网页 / 审核流程的路径；对外用 asset_create 或 asset_import' }),
} as const;
