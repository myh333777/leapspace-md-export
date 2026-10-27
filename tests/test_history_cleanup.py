#!/usr/bin/env python3
"""Synthetic-only Playwright regression tests; no live account is accessed."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests/history-fixture.html").read_text(encoding="utf-8")
SCRIPT = ROOT / "sciencedirect-academic-md.user.js"
URL = "https://www.sciencedirect.com/leapspace/?fixture_only=1"


def setup(browser, *, count=75, unknown=False, broken=False, accordion=False,
          pointer_only=False, deep=False, flat=False, reorder=False, delayed=False):
    context = browser.new_context(viewport={"width": 1280, "height": 850})
    page = context.new_page()
    context.route("https://www.sciencedirect.com/**",
                  lambda route: route.fulfill(
                      status=200, content_type="text/html; charset=utf-8", body=FIXTURE))
    page.add_init_script("window.__LS_MD_EXPORT_TEST__ = true;")
    page.goto(URL + f"&count={count}&unknown={int(unknown)}&broken={int(broken)}"
              f"&accordion={int(accordion)}&pointer_only={int(pointer_only)}"
              f"&deep={int(deep)}&flat={int(flat)}&reorder={int(reorder)}"
              f"&delayed={int(delayed)}")
    page.add_script_tag(path=str(SCRIPT))
    page.get_by_role("button", name="导出设置").click()
    page.get_by_role("button", name="清理聊天记录…").click()
    assert page.locator(".ls-history-preview-list,.ls-history-ack-input,"
                        ".ls-history-phrase-input,.ls-history-confirm").count() == 0
    assert page.get_by_role("button", name="开始清理").is_enabled()
    return context, page


def start(page):
    page.get_by_role("button", name="开始清理").click()


def expect_done(page, done, total, timeout=30000):
    page.get_by_text(f"已完成：已确认删除 {done}/{total} 条", exact=False).wait_for(
        timeout=timeout)


def expect_stopped(page, done, total, timeout=18000):
    page.get_by_text(f"已停止：已确认删除 {done}/{total} 条", exact=False).wait_for(
        timeout=timeout)


def check_recent_50(browser):
    context, page = setup(browser)
    try:
        assert page.get_by_role("spinbutton", name="删除最近几条").input_value() == "50"
        start(page)
        expect_done(page, 50, 50, 45000)
        deleted = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted) == 50
        assert deleted[0].endswith("000000000001")
        assert deleted[-1].endswith("000000000050")
        print("PASS one-click recent50: exact 50 deleted, older records preserved", flush=True)
    finally:
        context.close()


def check_all_without_extra_confirmation(browser):
    context, page = setup(browser, count=65)
    try:
        page.get_by_role("radio", name="全部可加载的会话").check()
        page.evaluate("() => {window.__TEST_CONFIRM_CALLED=0;window.confirm=()=>{window.__TEST_CONFIRM_CALLED++;return false};}")
        prompts = []
        page.on("dialog", lambda d: (prompts.append(d.message), d.dismiss()))
        start(page)
        expect_done(page, 65, 65, 50000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 65
        assert page.evaluate("window.__TEST_CONFIRM_CALLED") == 0
        assert prompts == [], prompts
        print("PASS all65 starts from one click without browser confirm or typed phrase", flush=True)
    finally:
        context.close()


def check_unknown_menu(browser):
    context, page = setup(browser, count=10, unknown=True)
    try:
        start(page)
        expect_stopped(page, 0, 10)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 0
        print("PASS unknown menu fails closed", flush=True)
    finally:
        context.close()


def check_load_failure(browser):
    context, page = setup(browser, count=10, broken=True)
    try:
        start(page)
        expect_stopped(page, 0, 0)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 0
        print("PASS load failure safely stops before any deletion", flush=True)
    finally:
        context.close()


def check_count_changed(browser):
    context, page = setup(browser, count=75)
    try:
        number = page.get_by_role("spinbutton", name="删除最近几条")
        number.fill("12")
        number.dispatch_event("change")
        start(page)
        expect_done(page, 12, 12)
        assert len(page.evaluate("window.__TEST_HISTORY__.deleted")) == 12
        page.get_by_role("button", name="关闭清理").click()
        page.get_by_role("button", name="导出设置").click()
        page.get_by_role("button", name="清理聊天记录…").click()
        assert page.get_by_role("spinbutton", name="删除最近几条").input_value() == "12"
        print("PASS recent N=12 one-click and preference persistence", flush=True)
    finally:
        context.close()


def check_stop_between_items(browser):
    context, page = setup(browser, count=25)
    try:
        page.evaluate("window.__TEST_STOP_AFTER=3")
        start(page)
        expect_stopped(page, 3, 25)
        deleted = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted) == 3 and deleted[-1].endswith("000000000003")
        print("PASS Stop after 3: remaining 22 untouched; accurate count", flush=True)
    finally:
        context.close()


def check_real_accordion_pointer_menu(browser):
    context, page = setup(browser, count=8, accordion=True, pointer_only=True)
    try:
        before = page.evaluate("""() => {
          const api=window.__LS_MD_EXPORT_API__, found=api.historyScope();
          return {isNav:found.scope===found.nav,
                  aria:found.toggle?.getAttribute('aria-expanded'),
                  count:api.visibleHistoryAnchors(found.scope).length};
        }""")
        assert before == {"isNav": False, "aria": "false", "count": 8}, before
        start(page)
        expect_done(page, 8, 8)
        expanded = page.evaluate("""()=>document.querySelector(
          '[data-testid=left-panel-nav] button[aria-label=Conversations]'
          ).getAttribute('aria-expanded')""")
        assert expanded == "true"
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 8
        assert page.locator('[aria-label="Projects"] a[href*="/leapspace/conversation/"]').count() == 1
        print("PASS real-shaped accordion with hidden pointer menu, project link preserved", flush=True)
    finally:
        context.close()


def check_reorder_keeps_frozen_ids(browser):
    context, page = setup(browser, count=8, reorder=True)
    try:
        start(page)
        expect_done(page, 8, 8)
        deleted = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted) == 8
        assert all(x.endswith(str(i).zfill(12)) for i, x in enumerate(deleted, 1)), deleted
        assert page.get_by_text("Inserted unrelated conversation").count() == 1
        print("PASS unrelated new conversation inserted mid-run is not deleted", flush=True)
    finally:
        context.close()


def check_slow_confirmation_at_most_once(browser):
    context, page = setup(browser, count=8, delayed=True)
    try:
        start(page)
        expect_done(page, 8, 8)
        state = page.evaluate("window.__TEST_HISTORY__")
        assert len(state["deleted"]) == 8 and state["confirmAttempts"] == 8, state
        print("PASS delayed native confirmation submitted only once per item", flush=True)
    finally:
        context.close()


def check_accordion_load_error(browser):
    context, page = setup(browser, count=7, accordion=True,
                          pointer_only=True, broken=True)
    try:
        start(page)
        expect_stopped(page, 0, 0)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 0
        print("PASS accordion loading failure fails closed", flush=True)
    finally:
        context.close()


def check_flat_sidebar_51(browser):
    context, page = setup(browser, count=64, flat=True)
    try:
        count = page.get_by_role("spinbutton", name="删除最近几条")
        count.fill("51")
        count.dispatch_event("change")
        start(page)
        expect_done(page, 51, 51, 55000)
        deleted = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted) == 51
        assert deleted[-1].endswith("000000000051")
        assert page.locator('[aria-label="Projects"] a[href*="/leapspace/conversation/"]').count() == 1
        print("PASS flat Conversations scope recent51, project decoy protected", flush=True)
    finally:
        context.close()


def check_deep_sidebar_51(browser):
    context, page = setup(browser, count=64, accordion=True,
                          deep=True, pointer_only=True)
    try:
        count = page.get_by_role("spinbutton", name="删除最近几条")
        count.fill("51")
        count.dispatch_event("change")
        start(page)
        expect_done(page, 51, 51, 55000)
        deleted = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted) == 51
        assert deleted[-1].endswith("000000000051")
        assert page.locator('[aria-label="Projects"] a[href*="/leapspace/conversation/"]').count() == 1
        print("PASS deep accordion recent51, decoy untouched", flush=True)
    finally:
        context.close()


def check_double_click_single_run(browser):
    context, page = setup(browser, count=8, delayed=True)
    try:
        page.evaluate("""() => {
          const b=document.querySelector('.ls-history-scan');b.click();b.click();
        }""")
        expect_done(page, 8, 8)
        state=page.evaluate("window.__TEST_HISTORY__")
        assert len(state["deleted"]) == 8 and state["confirmAttempts"] == 8, state
        print("PASS rapid double click cannot schedule duplicate batches", flush=True)
    finally:
        context.close()


if __name__ == "__main__":
    with sync_playwright() as pw:
        local_chromium=Path("/opt/homebrew/bin/chromium")
        executable=os.environ.get("CHROMIUM_BIN") or (
            str(local_chromium) if local_chromium.exists() else None)
        opts={"headless": True, "args": ["--no-sandbox"]}
        if executable: opts["executable_path"]=executable
        browser=pw.chromium.launch(**opts)
        try:
            check_recent_50(browser)
            check_all_without_extra_confirmation(browser)
            check_unknown_menu(browser)
            check_load_failure(browser)
            check_count_changed(browser)
            check_stop_between_items(browser)
            check_real_accordion_pointer_menu(browser)
            check_reorder_keeps_frozen_ids(browser)
            check_slow_confirmation_at_most_once(browser)
            check_accordion_load_error(browser)
            check_flat_sidebar_51(browser)
            check_deep_sidebar_51(browser)
            check_double_click_single_run(browser)
        finally:
            browser.close()
    print("PASS 13 scenarios, offline / simulated", flush=True)
