// ZoFHub: Interstellar's upstream Google Analytics (GT-K46PHV4) is removed.
// The vendored engine must not beacon to a third party's analytics property on
// page load; ZoFHub does not run Google's tag stack on its own pages, and the
// site CSP would refuse googletagmanager.com anyway. This no-op keeps the
// <script src=".../analytics.js"> reference valid without loading anything.
