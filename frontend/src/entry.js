const path = window.location.pathname.replace(/\/+$/, '');
if (path === '/changemodel') {
  await import('./changemodel.js');
} else {
  await import('./main.js');
}
