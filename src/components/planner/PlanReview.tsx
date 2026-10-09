import type { ModelInfo } from '../../api/types'
import type { PlanSession } from '../../api/planner'

/**
 * Xem lại và duyệt kế hoạch: ý kiến → kịch bản + nhân vật + timeline → áp dụng.
 *
 * Cổng duyệt hiển thị đúng trạng thái do server trả về, không tự suy diễn: nút
 * "Lên kịch bản" chỉ bấm được sau khi ý kiến đã được duyệt.
 */
export function PlanReview({
  session,
  videoModels,
  busy,
  applyModelId,
  autoGenerate,
  onApplyModelChange,
  onAutoGenerateChange,
  onGenerateIdeas,
  onApproveIdeas,
  onGeneratePlan,
  onApply,
  canApply,
}: {
  session: PlanSession
  /** Model tạo video đang bật, dùng để gán cho các cảnh khi áp dụng. */
  videoModels: ModelInfo[]
  busy: string
  applyModelId: string
  autoGenerate: boolean
  onApplyModelChange: (value: string) => void
  onAutoGenerateChange: (value: boolean) => void
  onGenerateIdeas: () => void
  onApproveIdeas: () => void
  onGeneratePlan: () => void
  onApply: () => void
  /** Có ít nhất một tin nhắn người dùng thì mới tổng hợp được ý kiến. */
  canApply: boolean
}) {
  const ideas = session.ideas
  const plan = session.plan
  const isBusy = busy !== ''
  const approved = session.status === 'ideas_approved' || session.status === 'plan_ready' || session.status === 'applied'

  return (
    <div className="planner-review">
      <div className="planner-step">
        <div className="planner-step-head">
          <span className={`planner-step-index ${ideas ? 'is-done' : ''}`}>1</span>
          <div>
            <strong>Ý kiến tổng hợp</strong>
            <p className="planner-hint">AI đọc lại hội thoại và chốt một đề xuất thống nhất.</p>
          </div>
        </div>

        <button
          type="button"
          className="primary-small-button"
          disabled={isBusy || !canApply}
          onClick={onGenerateIdeas}
        >
          {ideas ? 'Tổng hợp lại ý kiến' : 'Tổng hợp ý kiến'}
        </button>

        {ideas && (
          <div className="planner-ideas">
            <p className="planner-logline">{ideas.logline}</p>
            <dl className="planner-facts">
              <div><dt>Đối tượng</dt><dd>{ideas.audience || '—'}</dd></div>
              <div><dt>Tông</dt><dd>{ideas.tone || '—'}</dd></div>
              <div><dt>Thời lượng</dt><dd>{ideas.durationSeconds} giây</dd></div>
              <div><dt>Khung hình</dt><dd>{ideas.aspectRatio}</dd></div>
            </dl>
            {ideas.keyPoints.length > 0 && (
              <ul className="planner-list">
                {ideas.keyPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
            )}
            {ideas.characters.length > 0 && (
              <p className="planner-hint">Nhân vật dự kiến: {ideas.characters.join(', ')}</p>
            )}
            {ideas.risks.length > 0 && (
              <ul className="planner-risks">
                {ideas.risks.map((risk) => <li key={risk}>{risk}</li>)}
              </ul>
            )}
          </div>
        )}

        {ideas && !approved && (
          <button
            type="button"
            className="secondary-button"
            disabled={isBusy}
            onClick={onApproveIdeas}
          >
            Duyệt ý kiến này
          </button>
        )}
        {approved && <p className="planner-ok">Đã duyệt ý kiến.</p>}
      </div>

      <div className="planner-step">
        <div className="planner-step-head">
          <span className={`planner-step-index ${plan ? 'is-done' : ''}`}>2</span>
          <div>
            <strong>Kịch bản và timeline</strong>
            <p className="planner-hint">Mỗi cảnh có bối cảnh, nhân vật, lời thoại và thời lượng.</p>
          </div>
        </div>

        <button
          type="button"
          className="primary-small-button"
          disabled={isBusy || !approved}
          onClick={onGeneratePlan}
        >
          {plan ? 'Sinh lại kịch bản' : 'Lên kịch bản & timeline'}
        </button>
        {!approved && <p className="planner-hint">Cần duyệt ý kiến trước.</p>}

        {plan && (
          <div className="planner-plan">
            <h3>{plan.title || 'Kịch bản'}</h3>
            <p className="planner-hint">
              {plan.scenes.length} cảnh · tổng {plan.totalSeconds} giây
            </p>

            <div className="planner-cast">
              {plan.characters.map((character) => (
                <article className="planner-cast-card" key={character.name}>
                  <strong>{character.name}</strong>
                  {character.role && <em>{character.role}</em>}
                  <p>{character.appearance || 'Chưa mô tả ngoại hình.'}</p>
                  {character.reuseCharacterId && (
                    <span className="planner-badge">Dùng lại thư viện</span>
                  )}
                </article>
              ))}
            </div>

            <ol className="planner-timeline">
              {plan.scenes.map((scene, index) => (
                <li key={`${scene.title}-${index}`}>
                  <div className="planner-scene-head">
                    <strong>{index + 1}. {scene.title}</strong>
                    <span className="counter">{scene.durationSeconds}s</span>
                  </div>
                  {scene.background && <p><em>Bối cảnh:</em> {scene.background}</p>}
                  {scene.action && <p><em>Hành động:</em> {scene.action}</p>}
                  <p>
                    <em>Nhân vật:</em> {scene.characters.join(', ') || '—'}
                    {scene.speaker ? ` (nói: ${scene.speaker})` : ''}
                  </p>
                  {scene.dialogue && <p><em>Lời thoại:</em> “{scene.dialogue}”</p>}
                  {scene.shotNotes && <p className="planner-hint">{scene.shotNotes}</p>}
                </li>
              ))}
            </ol>

            {plan.warnings.length > 0 && (
              <ul className="planner-risks">
                {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="planner-step">
        <div className="planner-step-head">
          <span className={`planner-step-index ${session.status === 'applied' ? 'is-done' : ''}`}>3</span>
          <div>
            <strong>Chốt vào Studio</strong>
            <p className="planner-hint">
              Tạo dự án với nhân vật và cảnh ở trạng thái <em>chưa duyệt</em> — bạn xem lại
              trong Studio rồi mới tạo nội dung.
            </p>
          </div>
        </div>

        <label className="planner-field">
          Model tạo video cho các cảnh
          <div className="select-wrap">
            <select
              value={applyModelId}
              disabled={isBusy}
              onChange={(event) => onApplyModelChange(event.target.value)}
            >
              <option value="">Chọn sau trong Studio</option>
              {videoModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName || model.modelId}
                </option>
              ))}
            </select>
          </div>
        </label>

        <label className="planner-check">
          <input
            type="checkbox"
            checked={autoGenerate}
            disabled={isBusy}
            onChange={(event) => onAutoGenerateChange(event.target.checked)}
          />
          <span>Tự động xếp hàng tạo ngay khi tôi duyệt từng cảnh trong Studio</span>
        </label>

        {autoGenerate && videoModels.length === 0 && (
          <p className="project-cost-warning" role="alert">
            Chưa có model video nào đang bật. Hãy thêm và phân loại model trong API &amp; Models,
            nếu không cảnh sẽ nằm chờ.
          </p>
        )}

        <button
          type="button"
          className="generate-button"
          disabled={isBusy || !plan}
          onClick={onApply}
        >
          {session.status === 'applied' ? 'Mở lại dự án đã tạo' : 'Chốt & tạo dự án'}
        </button>
      </div>
    </div>
  )
}
