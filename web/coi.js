// Godot 웹 에디터는 SharedArrayBuffer(멀티스레드)가 필요해서 cross-origin isolation 헤더가 있어야 한다.
// GitHub Pages는 헤더를 설정할 수 없으므로 service worker(sw.js)가 응답에 헤더를 붙인다.
// 첫 방문에는 service worker가 아직 없으므로, 등록 후 한 번 새로고침한다.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var KEY = 'gwe:coi-reloaded';
  if (window.crossOriginIsolated) sessionStorage.removeItem(KEY);
  navigator.serviceWorker.register('sw.js').then(function () {
    if (window.crossOriginIsolated || sessionStorage.getItem(KEY)) return;
    navigator.serviceWorker.ready.then(function () {
      sessionStorage.setItem(KEY, '1');
      location.reload();
    });
  }).catch(function (e) {
    console.error('service worker 등록 실패:', e);
  });
})();
