#!/usr/bin/env python3
"""Synthetic-only Playwright tests for LeapSpace history cleanup.

Never points at a logged-in browser. Every target request is fulfilled from
the checked-in inert local HTML fixture.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests/history-fixture.html").read_text(encoding="utf-8")
SCRIPT = ROOT / "sciencedirect-academic-md.user.js"
URL = "https://www.sciencedirect.com/leapspace/?fixture_only=1"


def setup(browser, *, count=75, unknown=False, broken=False):
    context = browser.new_context(viewport={"width": 1280, "height": 850})
    page = context.new_page()
    context.route("https://www.sciencedirect.com/**",
                  lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=FIXTURE))
    page.add_init_script("window.__LS_MD_EXPORT_TEST__ = true;")
    page.goto(URL + f"&count={count}&unknown={int(unknown)}&broken={int(broken)}")
    page.add_script_tag(path=str(SCRIPT))
    page.get_by_role("button", name="导出设置").click()
    page.get_by_role("button", name="清理聊天记录…").click()
    return context, page


def check_recent_50(browser):
    context,page = setup(browser)
    try:
        field = page.get_by_role("spinbutton", name="删除最近几条")
        assert field.input_value() == "50"
        page.get_by_role("button", name="预览", exact=True).click()
        page.get_by_text("待删除 50 条", exact=False).wait_for(timeout=15000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 0
        page.get_by_role("checkbox", name="我理解记录删除后可能无法恢复").check()
        page.once("dialog", lambda d: d.accept())
        page.get_by_role("button", name="确认删除").click()
        page.get_by_text("已完成：已确认删除 50/50 条", exact=False).wait_for(timeout=24000)
        ids = page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(ids) == 50, (len(ids), ids[-3:])
        # No older records are deleted.
        assert ids[0].endswith("000000000001")
        assert ids[-1].endswith("000000000050")
        print("PASS recent50 preview -> native-menu -> dialog -> 50 verified removals")
    finally:
        context.close()


def check_all_confirmation(browser):
    context,page = setup(browser,count=65)
    try:
        page.get_by_role("radio", name="全部可加载的会话").check()
        page.get_by_role("button", name="预览", exact=True).click()
        page.get_by_text("待删除 65 条", exact=False).wait_for(timeout=18000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length")==0
        page.get_by_role("checkbox", name="我理解记录删除后可能无法恢复").check()
        confirm=page.get_by_role("button",name="确认删除")
        assert confirm.is_disabled(), "Must require typed all-delete phrase"
        page.locator(".ls-history-phrase-input").fill("删除全部")
        assert confirm.is_enabled()
        page.once("dialog",lambda d:d.dismiss())
        confirm.click()
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length") == 0, "Native confirm dismissed, no deletion permitted"
        page.once("dialog",lambda d:d.accept())
        confirm.click()
        page.get_by_text("已完成：已确认删除 65/65 条", exact=False).wait_for(timeout=30000)
        assert len(page.evaluate("window.__TEST_HISTORY__.deleted")) == 65
        print("PASS all65 phrase gate, modal cancel gate, 65 verified deletions")
    finally:
        context.close()


def check_unknown_menu(browser):
    context,page=setup(browser,count=10,unknown=True)
    try:
        page.get_by_role("button",name="预览",exact=True).click()
        page.get_by_text("待删除 10 条",exact=False).wait_for(timeout=16000)
        page.get_by_role("checkbox",name="我理解记录删除后可能无法恢复").check()
        page.once("dialog",lambda d:d.accept())
        page.get_by_role("button",name="确认删除").click()
        page.get_by_text("已停止：已确认删除 0/10 条",exact=False).wait_for(timeout=16000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length")==0
        print("PASS unknown DOM menu fail-closed; no synthetic conversations removed")
    finally:
        context.close()


def check_load_failure(browser):
    context,page=setup(browser,count=10,broken=True)
    try:
        page.get_by_role("button",name="预览",exact=True).click()
        page.get_by_text("扫描失败",exact=False).wait_for(timeout=9000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length")==0
        assert page.get_by_role("button",name="确认删除").is_disabled()
        print("PASS history load error blocks deletion")
    finally:
        context.close()


def check_count_changed(browser):
    context,page=setup(browser,count=75)
    try:
        count=page.get_by_role("spinbutton",name="删除最近几条")
        count.fill("12")
        count.dispatch_event("change")
        page.get_by_role("button",name="预览",exact=True).click()
        page.get_by_text("待删除 12 条",exact=False).wait_for(timeout=13000)
        assert page.evaluate("window.__TEST_HISTORY__.deleted.length")==0
        page.get_by_role("button",name="关闭清理").click()
        page.get_by_role("button",name="导出设置").click()
        page.get_by_role("button",name="清理聊天记录…").click()
        assert page.get_by_role("spinbutton",name="删除最近几条").input_value()=="12"
        print("PASS recent N persisted, preview not a destructive action")
    finally:
        context.close()


def check_stop_between_items(browser):
    context,page=setup(browser,count=25)
    try:
        page.get_by_role("button",name="预览",exact=True).click()
        page.get_by_text("待删除 25 条",exact=False).wait_for(timeout=14000)
        page.get_by_role("checkbox",name="我理解记录删除后可能无法恢复").check()
        # Site-simulation hook invokes the plugin Stop button after exactly
        # three synthetic confirmations. This never touches user data.
        page.evaluate("window.__TEST_STOP_AFTER=3")
        page.once("dialog",lambda d:d.accept())
        page.get_by_role("button",name="确认删除").click()
        page.get_by_text("已停止：已确认删除 3/25 条",exact=False).wait_for(timeout=16000)
        deleted=page.evaluate("window.__TEST_HISTORY__.deleted")
        assert len(deleted)==3
        assert deleted[-1].endswith("000000000003")
        print("PASS Stop cancels remaining 22 items; accurately counts 3 completed")
    finally:
        context.close()


if __name__ == "__main__":
    with sync_playwright() as pw:
        local_chromium = Path('/opt/homebrew/bin/chromium')
        executable = os.environ.get('CHROMIUM_BIN') or (str(local_chromium) if local_chromium.exists() else None)
        opts = {'headless': True, 'args': ['--no-sandbox']}
        if executable: opts['executable_path'] = executable
        browser = pw.chromium.launch(**opts)
        try:
            check_recent_50(browser)
            check_all_confirmation(browser)
            check_unknown_menu(browser)
            check_load_failure(browser)
            check_count_changed(browser)
            check_stop_between_items(browser)
        finally:
            browser.close()
    print("PASS 6 scenarios, all offline / simulated")
