"""Run against a local HTTP server; Python Playwright required.
python qa/browser_check.py --url http://127.0.0.1:8765 --output /tmp/mmd-browser
Use --engine webkit with a Playwright WebKit install for supplementary coverage.
"""
import argparse, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--url',default='http://127.0.0.1:8765')
parser.add_argument('--output',default='/tmp/mmd-browser')
parser.add_argument('--engine',choices=['chromium','webkit'],default='chromium')
args=parser.parse_args(); out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
results={'engine':args.engine,'matrix':[],'checks':[],'errors':[]}
with sync_playwright() as p:
    launch={'executable_path':'/usr/bin/chromium','args':['--no-sandbox']} if args.engine=='chromium' else {}
    browser=getattr(p,args.engine).launch(**launch)
    context=browser.new_context(locale='zh-CN')
    context.route('https://get.geojs.io/**',lambda r:r.abort())
    page=context.new_page();page.on('pageerror',lambda e:results['errors'].append(str(e)))
    for lang in ['zh','ja','en']:
        for width in [320,390,768,1440]:
            page.set_viewport_size({'width':width,'height':900})
            page.goto(args.url);page.select_option('#language-select',lang,force=True)
            page.wait_for_timeout(100)
            dimensions=page.evaluate('''() => ({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})''')
            assert dimensions['scroll']<=dimensions['client'],(lang,width,dimensions)
            assert page.locator('h1').is_visible()
            for selector in ['#features','#quality','#mmd','#start','#faq']:
                assert page.locator(selector).is_visible()
            page.screenshot(path=str(out/f'{lang}-{width}.png'),full_page=True)
            results['matrix'].append({'lang':lang,'width':width,'overflow':False})
    page.set_viewport_size({'width':390,'height':844});page.goto(args.url)
    page.locator('#menu-toggle').click();assert page.locator('#site-nav').is_visible()
    page.keyboard.press('Escape');assert page.locator('#menu-toggle').get_attribute('aria-expanded')=='false'
    assert page.locator('#menu-toggle').evaluate('(e)=>e===document.activeElement')
    page.locator('#menu-toggle').click();page.locator('#site-nav a[href="#mmd"]').click()
    assert page.locator('#menu-toggle').get_attribute('aria-expanded')=='false'
    results['checks'].append('mobile menu: open, Escape focus return, anchor close')
    page.select_option('#language-select','ja',force=True);page.reload();assert page.locator('html').get_attribute('lang')=='ja'
    results['checks'].append('manual locale persists across reload')
    page.locator('#tab-ai').click();page.keyboard.press('ArrowRight')
    assert page.locator('#demo-panel').get_attribute('data-mode')=='alpha'
    page.keyboard.press('End');assert page.locator('#demo-panel').get_attribute('data-mode')=='cut'
    page.keyboard.press('Home');assert page.locator('#demo-panel').get_attribute('data-mode')=='ai'
    slider=page.locator('#compare-range');slider.focus();page.keyboard.press('ArrowRight')
    assert slider.input_value()=='51'
    box=slider.bounding_box();page.mouse.move(box['x']+box['width']*.3,box['y']+box['height']/2);page.mouse.down();page.mouse.move(box['x']+box['width']*.7,box['y']+box['height']/2,steps=8);page.mouse.up()
    assert int(slider.input_value())>60
    results['checks'].append('tabs: click, arrows, Home/End; comparison: pointer drag and keyboard')
    first=page.locator('summary').first;first.focus();page.keyboard.press('Enter');assert page.locator('details').first.get_attribute('open') is not None
    results['checks'].append('FAQ keyboard disclosure')
    page.set_viewport_size({'width':1440,'height':900});page.locator('#motion-toggle').click();assert page.locator('body').evaluate('(e)=>e.classList.contains("motion-paused")')
    before=page.locator('.art-shape').evaluate('(e)=>getComputedStyle(e).transform')
    page.evaluate('scrollTo(0,200)');page.wait_for_timeout(100)
    assert before==page.locator('.art-shape').evaluate('(e)=>getComputedStyle(e).transform')
    page.emulate_media(reduced_motion='reduce');page.reload()
    assert page.locator('.reveal').first.evaluate('(e)=>getComputedStyle(e).animationName')=='none'
    assert page.locator('#film-rail').count()==0
    results['checks'].append('pause and reduced motion; full-page film removed')
    page.emulate_media(reduced_motion='no-preference');page.set_viewport_size({'width':1440,'height':900});page.goto(args.url)
    perf=page.evaluate('''async()=>{const intervals=[];let last=performance.now();for(let i=0;i<90;i++){await new Promise(requestAnimationFrame);const now=performance.now();intervals.push(now-last);last=now;scrollTo(0,i*24)}intervals.sort((a,b)=>a-b);return {medianMs:intervals[45],p95Ms:intervals[85],over50ms:intervals.filter(x=>x>50).length,nodes:document.querySelectorAll('*').length}}''')
    results['scrollSample']=perf
    for locale,country,expected in [('en-US','JP','ja'),('en-US','CN','zh-CN'),('zh-CN','US','en')]:
        c=browser.new_context(locale=locale);c.route('https://get.geojs.io/**',lambda r:r.fulfill(json={'country':country}));q=c.new_page();q.goto(args.url);q.wait_for_function('(lang)=>document.documentElement.lang===lang',arg=expected);c.close()
    results['checks'].append('IP country mapping JP/CN/US')
    c=browser.new_context(locale='en-US');c.route('https://get.geojs.io/**',lambda r:r.abort());q=c.new_page();q.goto(args.url);assert q.locator('html').get_attribute('lang')=='en';c.close()
    results['checks'].append('IP failure falls back to browser language')
    c=browser.new_context(locale='en-US');c.add_init_script('''Object.defineProperty(Storage.prototype,'setItem',{value(){throw Error('blocked')}});Object.defineProperty(Storage.prototype,'getItem',{value(){throw Error('blocked')}});window.fetch=()=>new Promise(r=>setTimeout(()=>r({ok:true,json:()=>Promise.resolve({country:'JP'})}),800));''');q=c.new_page();q.goto(args.url);q.select_option('#language-select','zh');q.wait_for_timeout(1000);assert q.locator('html').get_attribute('lang')=='zh-CN';c.close()
    results['checks'].append('manual choice beats delayed geo result even when storage is blocked')
    c=browser.new_context(java_script_enabled=False,viewport={'width':320,'height':800});q=c.new_page();q.goto(args.url);assert q.locator('#site-nav').is_visible();assert q.locator('h1').is_visible();assert q.locator('.audio-feature-copy').is_visible();assert q.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth');q.locator('summary').first.click();assert q.locator('details').first.get_attribute('open') is not None;q.screenshot(path=str(out/'no-js.png'),full_page=True);c.close()
    results['checks'].append('no JS: content, navigation, FAQ, no overflow at 320px')
    c=browser.new_context();c.add_init_script('delete window.IntersectionObserver');c.route('https://get.geojs.io/**',lambda r:r.abort());q=c.new_page();q.goto(args.url);assert q.locator('.feature-card').first.is_visible();c.close()
    results['checks'].append('IntersectionObserver absent: content remains visible')
    assert not results['errors'],results['errors']
    browser.close()
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
