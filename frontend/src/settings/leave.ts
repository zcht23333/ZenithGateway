export interface SettingsLeaveContext {
  state: {saving:boolean; needsConfirmation:boolean}
  protectedDraft:boolean
  clear():void
}
export function confirmSettingsLeave(editor: SettingsLeaveContext) {
  if (editor.state.saving) {
    window.alert('正在等待服务端保存响应，请等待结果后再离开。')
    return false
  }
  if (!editor.protectedDraft) return true
  const message = editor.state.needsConfirmation
    ? '保存结果尚未确认。离开将丢弃本页草稿，但不会撤销服务端可能已写入的配置。确认离开？'
    : '有未保存的配置修改。离开将丢弃本页草稿，确认离开？'
  if (!window.confirm(message)) return false
  editor.clear()
  return true
}
