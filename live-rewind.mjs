import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const H='http://8.213.197.187:17900', P=process.env.P, OUT=process.env.OUT, KIND=process.env.KIND||'cleanup';
const pw=readFileSync('/workspace/remote/e2e-test-account.txt','utf8').match(/^pass\w*\s*[:=]?\s*(.+)$/m)[1].trim();
const S=process.env.S;
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
let created=null;
for (const width of [1280,390]) {
  const ctx=await b.newContext({viewport:{width,height:width>500?860:844}}); const page=await ctx.newPage();
  await page.request.get(H+'/api/auth/state');
  const cs=(await ctx.cookies()).find(c=>c.name==='hub_csrf')?.value;
  const r=await page.request.post(H+'/api/auth/login',{data:{email:'e2e-tester@example.invalid',password:pw},headers:{origin:H,'x-hub-csrf':cs}});
  if(!r.ok()) throw new Error('login '+r.status());
  await page.goto(`${H}/#/p/${P}/focus/${S}`); await page.waitForTimeout(2500);
  await page.getByTestId('msg-menu').nth(1).click();
  await page.screenshot({path:`${OUT}/live-menu-${width}.png`});
  await page.getByTestId('msg-rewind').click();
  const d=page.getByTestId('rewind-dialog'); await d.getByTestId('rewind-files-note').waitFor(); await page.waitForTimeout(800);
  await d.getByTestId('rewind-files').check();
  console.log(width,'note:',await d.getByTestId('rewind-files-note').innerText(),'overflow:',await d.evaluate(el=>el.scrollWidth>el.clientWidth+1));
  await page.screenshot({path:`${OUT}/live-dialog-${width}.png`});
  if (width===390) {
    const resp=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/rewind'));
    await d.getByTestId('rewind-go').click(); const r=await resp; created=await r.json(); console.log('status',r.status(),JSON.stringify({origin:created.session?.origin,files:created.files}));
    await page.waitForTimeout(4000);
    console.log('url has new',page.url().includes(created.session.id),'draft:',await page.locator('textarea').last().inputValue());
    await page.screenshot({path:`${OUT}/live-after-rewind-390.png`});
  }
  await ctx.close();
}
await b.close(); console.log('NEW='+created?.session?.id);
