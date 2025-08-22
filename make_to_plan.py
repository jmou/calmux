import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass
class Rule:
    target: str
    dependencies: list[str]
    recipe: list[str]


def parse_rules(fh: Iterable[str]):
    rule: Rule | None = None
    rules: dict[str, Rule] = {}
    bindings: dict[str, str] = {}

    for line in fh:
        # Skip comments and blank lines.
        if not re.sub(r"#.*", "", line).strip():
            continue

        if line.startswith("\t"):
            assert rule is not None
            replaced = (
                line.strip()
                .replace("$<", rule.dependencies[0] if rule.dependencies else "")
                .replace("$^", " ".join(rule.dependencies))
                .replace("$@", rule.target)
            )
            for name, value in bindings.items():
                replaced = replaced.replace(f"$({name})", value)
            rule.recipe.append(replaced)
        elif match := re.match(r"^(\S+) = (.*)\n$", line):
            bindings[match[1]] = match[2]
        else:
            target, dependencies = [x.strip() for x in line.split(":")]
            dependencies = dependencies.split()
            rule = Rule(target, dependencies, [])
            rules[target] = rule

    return rules


def q(s: str):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def ident(s: str):
    # knit does not allow / in step names
    return "rule@" + s.replace("/", "@_")


def dfs(rule: Rule, rules: dict[str, Rule], visited: set[str]):
    if rule.target in visited:
        return
    visited.add(rule.target)

    for dep in rule.dependencies:
        if dep in rules:
            dfs(rules[dep], rules, visited)

    prefix = f"step {ident(rule.target)}"
    if not rule.recipe and len(rule.dependencies) == 1:
        print(f"{prefix}: identity")
        # knit can copy a subdirectory but not all outputs.
        print(f"    result/ = {ident(rule.dependencies[0])}:result/")
    elif len(rule.recipe) == 1:
        if match := re.match(r"^\$\(MAKE\) -C (\S+) (.+)", rule.recipe[0]):
            subdir, target = match[1], match[2]
            print(f'{prefix}@plan: cmd "sh" "in/plan.sh"')
            print(
                '    plan.sh = "exec python3 in/make_to_plan.py in/Makefile $target > out/plan.knit"'
            )
            print(f"    Makefile = ./{subdir}/Makefile")
            print(f'    $target = "{target}"')
            print("    make_to_plan.py = ./make_to_plan.py")

            print(
                f"{prefix}@flow: flow ./{subdir}/ {ident(rule.target)}@plan:plan.knit"
            )
            if rule.dependencies:
                assert len(rule.dependencies) == 1
                assert rule.dependencies[0] == f"{subdir}/_params/"
                for dep in rules[rule.dependencies[0]].dependencies:
                    print(f"    {dep} = {ident(dep)}:result/{dep}")

            print(f"{prefix}: identity")
            print(f"    result/{subdir}/ = {ident(rule.target)}@flow:result/")
        else:
            print(f'{prefix}: cmd "sh" "-e" "in/run.sh"')
            print(
                '    run.sh = "cd in; mkdir -p $(dirname $_target); sh recipe; install -D $_target ../out/result/$_target"'
            )
            print(f'    $_target = "{rule.target}"')
            print(f'    recipe = "{q(rule.recipe[0])}"')
            for dep in rule.dependencies:
                if dep in rules:
                    print(f"    {dep} = {ident(dep)}:result/{dep}")
                elif dep.startswith("_params/"):
                    print(f"    {dep} = _params:{dep.split('/', 1)[1]}")
                else:
                    print(f"    {dep} = ./{dep}")
    elif rule.target.endswith("/_params/"):
        pass
    else:
        raise Exception("unhandled rule", rule.target)


def main():
    _, filename, target = sys.argv

    with open(filename) as fh:
        rules = parse_rules(fh)

    print("step _params: params")
    for rule in rules.values():
        for dep in rule.dependencies:
            if dep.startswith("_params/"):
                print(f"    {dep.split('/', 1)[1]} = !")

    dfs(rules[target], rules, set())


if __name__ == "__main__":
    main()
