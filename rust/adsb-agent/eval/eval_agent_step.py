"""Stage B: does the LLM still pick the right tool when it sees fewer of them?

    uv run python eval/eval_agent_step.py --mode full   --limit 30
    uv run python eval/eval_agent_step.py --mode ranked --limit 30 --top-k 10
    uv run python eval/eval_agent_step.py --mode groups --sample 60 --top-k 4

Modes: ``full`` binds every tool; ``ranked`` the decision model's top-k tools;
``groups`` the top-k tool families by embedding similarity (eval_groups.py).

Sends each record to the real chat model **once** -- system prompt, bound tools,
the conversation -- and reads the tool calls on the first reply. The graph is
not run, so no tool executes and nothing touches the desktop or the database.
Run both modes on the same records and compare the two MLflow runs.

Slow: one LLM call per record. ``--sample N`` picks a reproducible random subset;
use the same N and seed for both modes so they see the same records.

Scorers:
  first_call_expected  the reply calls a needed tool (or, for a record that
                       needs none, calls nothing)
  called_unbound_tool  the reply names a tool that was not bound -- the risk of
                       filtering while the guidelines still mention every tool
  input_tokens         prompt tokens the LLM reported
  latency_s            wall-clock time of the LLM call
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import threading
import time

import httpx
from common import EVAL_DIR, labels_tag, load_tool_surface, overrides_tag, setup_mlflow
from common import DATASET_VERSION
from eval_ranker import NOT_RANKED, data_params, load_records, needed_groups, sample_records

from adsb_agent.config import settings
from adsb_agent.graph import _to_openai_tools
from adsb_agent.server_tools import SERVER_TOOL_NAMES
from adsb_agent.system_prompt import attach_context, render_system_prompt
from adsb_agent.tool_ranker import pick, rank_tools


async def first_reply(
    question: str,
    history: list[str],
    mode: str,
    top_k: int,
    surface: list,
    *,
    context: list | None = None,
    placement: str = "system",
):
    """One LLM call. ``context`` is ambient UI state, placed like the agent does
    for ``settings.context_placement`` (see ``adsb_agent.llm``)."""
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    client_tools = [t for t in surface if t.name not in SERVER_TOOL_NAMES]
    bound = None
    if mode == "groups":
        from eval_groups import select_by_embedding

        bound = select_by_embedding(question, history, surface, top_k)
    elif mode == "ranked":
        rankable = [t for t in surface if t.name not in NOT_RANKED]
        async with httpx.AsyncClient() as client:
            scores = await rank_tools(
                rankable,
                question,
                history,
                client,
                url=settings.tool_ranker_url,
                model=settings.tool_ranker_model,
                timeout=30.0,
            )
        bound = pick(rankable, scores, top_k=top_k, pinned=settings.tool_ranker_pinned)

    turns = [HumanMessage(content=h) for h in history] + [HumanMessage(content=question)]
    on_user = placement == "user"
    if on_user:
        turns = attach_context(turns, context)
    system = render_system_prompt(client_tools, None if on_user else context, bound_tools=bound)
    messages = [SystemMessage(content=system), *turns]

    model = ChatOpenAI(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.model,
        temperature=settings.temperature,
        max_tokens=settings.max_tokens,
        max_retries=0,
    ).bind_tools(_to_openai_tools(surface if bound is None else bound))

    started = time.perf_counter()
    reply = await model.ainvoke(messages)
    usage = getattr(reply, "usage_metadata", None) or {}
    return {
        "tool_calls": [tc["name"] for tc in reply.tool_calls],
        "tool_args": [tc["args"] for tc in reply.tool_calls],
        "text": reply.content if isinstance(reply.content, str) else "",
        "bound": [t.name for t in (surface if bound is None else bound)],
        "input_tokens": usage.get("input_tokens", 0),
        "latency_s": round(time.perf_counter() - started, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["full", "ranked", "groups"], required=True)
    parser.add_argument(
        "--top-k",
        type=int,
        default=settings.tool_ranker_top_k,
        help="tools to keep (ranked) or families to keep (groups)",
    )
    parser.add_argument(
        "--context-placement",
        choices=["none", "system", "user"],
        default="none",
        help="send a sample UI state, in the system prompt or on the user message",
    )
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sample", type=int, help="a reproducible random subset of N records")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    # A local model serves one request at a time; parallel calls only queue and
    # inflate the latency being measured.
    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "1")
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    surface = load_tool_surface()
    records = sample_records(
        load_records(args.data, args.limit, args.dataset_version), args.sample, args.seed
    )

    context = None
    if args.context_placement != "none":
        from cache_experiment import ui_state

        context = ui_state(12)

    # Replies recorded here, not read back from the evaluation result: MLflow
    # averages over the records whose prediction succeeded and its result
    # table is not always available, so a failing subset would go unnoticed.
    replies: list[dict] = []

    # One event loop for the whole run, on its own thread. `asyncio.run` per
    # call closes the loop under the OpenAI client's shared connection pool, and
    # every second call then died with "Event loop is closed" -- silently, as
    # MLflow just leaves failed records out of the means.
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()

    def predict(question: str, history: list[str] | None = None) -> dict:
        call = first_reply(
            question,
            list(history or []),
            args.mode,
            args.top_k,
            surface,
            context=context,
            placement=args.context_placement,
        )
        try:
            reply = asyncio.run_coroutine_threadsafe(call, loop).result()
        except Exception as e:
            replies.append({"question": question, "error": f"{type(e).__name__}: {e}"})
            raise
        replies.append({"question": question, **{k: v for k, v in reply.items() if k != "bound"}})
        return reply

    @scorer
    def first_call_expected(outputs, expectations) -> bool:
        groups = needed_groups(expectations)
        if not groups:
            return not outputs["tool_calls"]
        needed = {t for g in groups for t in g}
        return any(t in needed for t in outputs["tool_calls"])

    @scorer
    def called_unbound_tool(outputs) -> bool:
        return any(t not in outputs["bound"] for t in outputs["tool_calls"])

    @scorer
    def input_tokens(outputs) -> int:
        return outputs["input_tokens"]

    @scorer
    def latency_s(outputs) -> float:
        return outputs["latency_s"]

    name = f"agent-step-{args.mode}" + ("" if args.mode == "full" else f"-k{args.top_k}")
    if args.context_placement != "none":
        name += f"-ctx-{args.context_placement}"
    name += overrides_tag() + labels_tag()
    with mlflow.start_run(run_name=name):
        mlflow.log_params(
            {
                "stage": "B-agent-step",
                "mode": args.mode,
                "context_placement": args.context_placement,
                "top_k": "all" if args.mode == "full" else args.top_k,
                "llm_model": settings.model,
                "records": len(records),
                "sample_seed": args.seed if args.sample else "all",
                **data_params(args.data, args.dataset_version),
            }
        )
        result = mlflow.genai.evaluate(
            data=records,
            predict_fn=predict,
            scorers=[first_call_expected, called_unbound_tool, input_tokens, latency_s],
        )
    # Per-record results, so two modes can be compared record by record without
    # querying traces back from the server.
    results_dir = EVAL_DIR / "results"
    results_dir.mkdir(exist_ok=True)
    out_path = results_dir / f"{name}-n{len(records)}.jsonl"
    out_path.write_text("".join(json.dumps(r, default=str) + "\n" for r in replies))
    print(f"\nmode={args.mode}  records={len(records)}  per-record results: {out_path}")
    answered = {r["question"] for r in replies if "error" not in r}
    asked = {r["inputs"]["question"] for r in records}
    if answered >= asked:
        print(f"  all {len(asked)} requests got a reply")
    else:
        print(
            f"WARNING: only {len(answered & asked)} of {len(asked)} requests got a reply; "
            "the means below cover those only"
        )
    for key in sorted(result.metrics):
        print(f"  {key:<32} {result.metrics[key]:.3f}")


if __name__ == "__main__":
    main()
