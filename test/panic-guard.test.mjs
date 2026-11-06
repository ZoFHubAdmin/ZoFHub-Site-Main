// public/js/panic.js's input-aware guard (isEditableTarget): the global
// keydown hotkey handler must never fire while the visitor is typing — added
// so a chat box, a form, or any other field cannot be
// interrupted by a plain-letter custom hotkey.
//
// panic.js has top-level document.addEventListener(...) calls, so a
// bare import under plain `node --test` throws with no DOM. A minimal stub,
// set BEFORE the dynamic import, is enough: readyState stays 'loading' so
// wireHeaderButton() is deferred (registered via the no-op addEventListener
// stub) rather than actually run, and the two other top-level
// addEventListener calls are no-ops too. isEditableTarget() itself takes a
// plain object — no DOM needed to call it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = {
  readyState: 'loading',
  addEventListener() {},
  removeEventListener() {},
};

const { isEditableTarget } = await import('../public/js/panic.js');

describe('isEditableTarget', () => {
  test('text-entry elements are editable', () => {
    assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
    assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
    assert.equal(isEditableTarget({ isContentEditable: true, tagName: 'DIV' }), true);
  });

  test('ordinary elements are not editable', () => {
    assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
    assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
    assert.equal(isEditableTarget({ tagName: 'BODY' }), false);
    assert.equal(isEditableTarget({ tagName: 'A' }), false);
  });

  test('a falsy or shapeless target is never editable', () => {
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget(undefined), false);
    assert.equal(isEditableTarget({}), false);
  });

  test('isContentEditable is checked before tagName, so a contenteditable DIV counts', () => {
    assert.equal(isEditableTarget({ isContentEditable: true }), true);
  });

  test('a falsy isContentEditable on a non-input tag is not editable', () => {
    assert.equal(isEditableTarget({ isContentEditable: false, tagName: 'SPAN' }), false);
  });
});
