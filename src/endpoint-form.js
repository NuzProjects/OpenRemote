// The endpoint form's checks now live with the console's other field checks in
// form-checks.js, so each form's rules read in one place. Re-exported here so
// the endpoint table's import is unchanged.

export { checkBaseUrl } from './form-checks.js'
