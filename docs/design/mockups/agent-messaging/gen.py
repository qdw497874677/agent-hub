# 生成三个静态选型稿：python3 gen.py
def av(t,dot=None,h=False):
    d=f'<i class="dot {dot}"></i>' if dot else ''
    return f'<div class="av{" h" if h else ""}">{t}{d}</div>'
def msg(who,a,body,tags='',state='',me=False,dot=None):
    return f'''<div class="msg{' me' if me else ''}">{av(a,dot,me)}<div><div class="who">{who}{tags}</div><div class="b">{body}</div>{f'<div class="state">{state}</div>' if state else ''}</div></div>'''
P='<span class="tag">持久型</span>'
U='<span class="tag warn">agent 消息 · 不可信</span>'
GROUP=f'''
<div class="sys">群成员 David · @reviewer · @tester · @deployer —— 每个 agent 在本群有一个持久型会话</div>
{msg('David','D','今晚能发 v0.9 吗？<span class="at">@all</span>',me=True,state='回复策略：全部（3）· <span class="q">已回 2/3</span>')}
{msg('reviewer','R','PR #122 已审完，两处小问题已修，可以发。',P,dot='on-l')}
{msg('tester','T','e2e 全绿（148/148），移动端截图已对比。',P,dot='on-l')}
{msg('deployer','Dp','<span class="sub">（还没回）正在处理上一轮：灰度 v0.8.3</span>',P,state='<span class="q">● 排队中 · 前面 1 条</span> · 当前这一轮结束后作为新的一轮',dot='busy')}
{msg('David','D','<span class="at">@perf</span> 帮忙压测一下 release 分支',me=True,state='等批准 · @perf 不在群里，需要派生任务型会话')}
<div class="approve"><div style="font-weight:600">派生新会话需要你批准</div>
<div class="row"><span class="pill a">角色 perf</span><span class="pill">任务型 · 全新上下文</span><span class="pill">worker omarchy · codex</span><span class="pill">预算 200k tokens / 30 分钟</span><span class="pill">深度 1/4</span></div>
<div class="sub">发起：David（群「发布小组」）· 结果会以任务卡贴回本群</div>
<div class="row" style="margin-top:8px"><button class="btn pri">批准</button><button class="btn">拒绝</button><button class="btn">改设置…</button></div></div>
<div class="sys">@reviewer 把「修 lint」转给 @fixer（任务型）· 查看调用链</div>
{msg('reviewer','R','顺手开了个任务修 lint，好了会贴结果：<br><a class="chip" href="#canvas"><i class="st"></i>任务 · fixer · 运行中 4m · 12k tokens<span class="at">打开画布 →</span></a>',P,dot='on-l')}
'''
DM=f'''
<div class="sys">私聊 · @reviewer（持久型 · 项目角色 reviewer）</div>
{msg('David','D','看下 PR #122 的设计稿，重点是 §3.4',me=True,state='已读')}
{msg('reviewer','R','看完了。§3.4 建议补一条：任务型结束后结果要贴回发起它的那个聊天。我去问下 tester 的意见。',P,dot='on-l')}
<div class="msg"><div style="width:28px"></div><div><a class="chip"><i class="st" style="background:var(--sage)"></i>→ <span class="at">@tester</span> ask「这个用例能过吗？」· 已回复 · 38s</a></div></div>
{msg('tester','T','能过，我在 tester 会话里跑过了。',P+U,dot='on-l')}
{msg('David','D','好，那顺便把 lint 修了',me=True,state='<span class="q">● 排队中 · 前面 1 条</span>（reviewer 正忙）')}
<div class="sys">上下文已自动压缩 · 10-30 21:40 PDT · 保留摘要 1.8k tokens</div>
'''
def side(active='g'):
    def it(a,n,s,dot,on=False,badge='',h=False):
        return f'<div class="item{" on" if on else ""}">{av(a,dot,h)}<div class="col"><span class="name">{n}</span><span class="meta">{s}</span></div>{f"<span class=badge>{badge}</span>" if badge else ""}</div>'
    return f'''<aside class="side col"><div class="hd">消息 <span class="meta" style="margin-left:auto">agent-hub</span></div>
<div class="sec">群聊</div>{it('#','发布小组','3 agent · 等待 2/3',None,active=='g','2')}{it('#','设计评审','2 agent · 空闲',None)}
<div class="sec">agent 联系人（持久型）</div>
{it('R','reviewer','在线 · claude · 项目角色','on-l',active=='d')}{it('T','tester','在线 · codex','on-l')}{it('Dp','deployer','忙 · 排队 1','busy',badge='1')}{it('W','writer','离线 · worker 不在','off')}
<div class="sec">人</div>{it('D','David','你',None,h=True)}</aside>'''
def chat(title,sub,feed,policy=True):
    pol='<div class="policy">等待回复 <b style="color:var(--acc)">2/3</b><span class="bar"><i></i></span><span class="desk-only">还差 @deployer（排队中）· </span>剩 12 分钟<span class="pill" style="margin-left:auto">回复策略：全部</span></div>' if policy else ''
    return f'''<main class="main col"><div class="hd"><span class="mobile-only" style="color:var(--s)">‹</span>{title}<span class="meta">{sub}</span><span class="mobile-only pill" style="margin-left:auto">成员</span></div>{pol}
<div class="feed">{feed}</div><div class="comp"><div class="input"><span class="pill a">@</span>发消息，@ 成员或角色…<span class="pill desk-only" style="margin-left:auto">回复策略 ▾</span></div></div></main>'''
def detail():
    return '''<div class="sec">联系人详情</div><div class="item">'''+av('R','on-l')+'''<div class="col"><span class="name">reviewer</span><span class="meta">持久型 · 第 3 代</span></div></div>
<div class="kv"><span>运行时</span><span>claude · omarchy</span></div><div class="kv"><span>状态</span><span style="color:var(--sage)">在线</span></div>
<div class="kv"><span>上下文</span><span>116k / 200k</span></div><div class="meter"><i></i></div>
<div class="kv"><span>上次自动压缩</span><span>21:40 PDT</span></div><div style="padding:8px 14px"><button class="btn">重启会话（带摘要）</button></div>'''
def page(name,body,extra=''):
    return f'''<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{name}</title><link rel="stylesheet" href="common.css"><style>{extra}</style></head><body>{body}
<template id="dmfeed">{DM}</template><template id="dmhd">私聊 · reviewer <span class="meta">持久型 · 在线</span></template>
<script>if(location.hash=='#dm'){{document.querySelectorAll('[data-dm]').forEach(e=>e.innerHTML=e.dataset.dm?document.getElementById(e.dataset.dm).innerHTML:'');document.querySelectorAll('.policy').forEach(e=>e.remove())}}</script></body></html>'''
def mainchat():
    return chat('发布小组 ','群 · 4 人',GROUP).replace('<div class="feed">','<div class="feed" data-dm="dmfeed">').replace('<div class="hd"><span class="mobile-only" style="color:var(--s)">‹</span>','<div class="hd"><span class="mobile-only" style="color:var(--s)">‹</span><span data-dm="dmhd">',1).replace('<span class="meta">群 · 4 人</span>','<span class="meta">群 · 4 人</span></span>',1)
# A
A=page('选型 A · IM 侧栏',f'''<div class="app">{side()}{mainchat()}<aside class="right col"><div class="hd">私聊预览 · reviewer</div><div class="feed" style="gap:8px;font-size:12px">{DM}</div>{detail()}</aside></div>''')
# B
nodes=[('reviewer','R',60,90,'在线 · 持久型','on-l'),('tester','T',60,210,'在线 · 持久型','on-l'),('deployer','Dp',60,330,'忙 · 排队 1','busy')]
nb=''.join(f'<div class="node" style="left:{x}px;top:{y}px">{av(a,d)}<div class="col"><b>{n}</b><span class="meta">{s}</span></div></div>' for n,a,x,y,s,d in nodes)
canvas=f'''<section class="main canvasv"><div class="hd">项目 agent-hub · 画布<span class="meta">持久型在左 · 任务型在右</span></div>
<div class="grp" style="left:40px;top:58px;width:250px;height:370px"><span class="meta">群「发布小组」</span></div>{nb}
<div class="node task" style="left:400px;top:90px"><i class="st"></i><div class="col"><b>任务 · fixer</b><span class="meta">运行中 4m · 由 reviewer 派生</span></div></div>
<div class="node task wait" style="left:400px;top:230px"><i class="st"></i><div class="col"><b>任务 · perf</b><span class="meta">等批准</span></div></div>
<svg style="position:absolute;inset:0;pointer-events:none" width="100%" height="100%"><path d="M270 110 C 340 110,340 120,400 120" stroke="#8a6a3d" fill="none" stroke-dasharray="4 4"/><path d="M290 230 C 340 230,350 260,400 260" stroke="#3c4649" fill="none" stroke-dasharray="4 4"/></svg></section>'''
Bcss='''.canvasv{position:relative;background-image:radial-gradient(#2e3639 1px,transparent 1px);background-size:20px 20px}.node{position:absolute;display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--strong);border-radius:10px;padding:10px 12px;width:210px}.node.task{border-color:var(--accd)}.node .st{width:8px;height:8px;border-radius:50%;background:var(--acc)}.node.wait{border-style:dashed}.grp{position:absolute;border:1px dashed var(--strong);border-radius:14px;padding:6px 10px}.drawer{width:520px;border-left:1px solid var(--hair);background:var(--panel);display:flex;flex-direction:column}.drawer .main{background:var(--panel)}.tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--hair)}@media(max-width:600px){.canvasv{display:none}.drawer{width:100%}}'''
B=page('选型 B · 画布内聊天',f'''<div class="app">{canvas}<div class="drawer"><div class="tabs"><span class="pill a">发布小组</span><span class="pill">私聊 reviewer</span><span class="pill">+ 新聊天</span><span class="pill mobile-only" style="margin-left:auto">‹ 画布</span></div>{mainchat()}</div></div>''',Bcss)
# C
trace='''<div class="sec">本群调用链（迷你画布）</div><div class="tree">
<div>David <span class="meta">post @all</span></div><div class="l1">reviewer <span style="color:var(--sage)">✓</span></div><div class="l1">tester <span style="color:var(--sage)">✓</span></div><div class="l1">deployer <span class="q">排队</span></div>
<div class="l1">reviewer → <a class="chip" style="margin:2px 0"><i class="st"></i>fixer 任务 4m</a></div><div class="l1">perf <span class="q">等批准</span></div></div>
<div style="padding:4px 14px 10px"><button class="btn">在项目画布中打开 →</button></div>'''
Ccss='.tree{padding:4px 14px;font-size:12px;display:flex;flex-direction:column;gap:6px}.tree .l1{padding-left:14px;border-left:1px solid var(--strong);margin-left:6px}'
C=page('选型 C · 混合',f'''<div class="app">{side()}{mainchat()}<aside class="right col">{trace}{detail()}</aside></div>''',Ccss)
for n,h in (('option-a',A),('option-b',B),('option-c',C)): open(n+'.html','w').write(h)
