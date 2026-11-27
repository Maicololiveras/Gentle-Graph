import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, type TestContext } from "node:test";
import { graphGuide, graphImpact } from "../lib/gentle-graph/index.ts";
import { formatGuide } from "../lib/gentle-graph/format.ts";
import { clearMemoryCache } from "../lib/gentle-graph/store.ts";
import { detectArchitecture } from "../lib/gentle-graph/arch-detector.ts";

function solution(t: TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-architecture-"));
  t.after(() => { clearMemoryCache(root); fs.rmSync(root, {recursive: true, force: true}); });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, body);
  }
  return {projectRoot: root};
}

it("detects Clean + WPF, reads .NET references, and traces the generated command", t => {
  const vm = "src/MyApp.Wpf/ViewModels/OrderViewModel.cs";
  const view = "src/MyApp.Wpf/Views/OrderView.xaml";
  const test = "tests/MyApp.Tests/OrderViewModelTests.cs";
  const project = "src/MyApp.Wpf/MyApp.Wpf.csproj";
  const opts = solution(t, {
    "src/MyApp.Domain/Entities/Order.cs":"public record Order(int Id);",
    "src/MyApp.Application/Interfaces/IOrderService.cs":"public interface IOrderService {}",
    "src/MyApp.Infrastructure/Services/OrderService.cs":"public class OrderService : IOrderService {}",
    [project]:'<Project><ItemGroup><ProjectReference Include="..\\MyApp.Application\\MyApp.Application.csproj"/><PackageReference Include="CommunityToolkit.Mvvm"/></ItemGroup></Project>',
    [vm]:"public partial class OrderViewModel {\n public OrderViewModel(IOrderService service) {}\n [RelayCommand] private async Task SaveOrderAsync() { await Save(); }\n}",
    [view]:'<UserControl x:Class="Shop.OrderView" xmlns:vm="clr-namespace:Shop" d:DataContext="{d:DesignInstance vm:OrderViewModel}"><Button Command="{Binding SaveOrderCommand}"/></UserControl>',
    [view+".cs"]:"public partial class OrderView {}",
    [test]:"public class OrderViewModelTests {}",
    "obj/Generated.cs":"class Generated {}", "TestResults/Artifact.cs":"class Artifact {}"
  });
  const text = formatGuide(graphGuide("order",opts));
  assert.match(text,/ARCH: Clean Architecture \+ WPF MVVM \(CommunityToolkit.Mvvm\)/);
  assert.match(text,/BOUNDARIES: Domain/);
  const profile = JSON.parse(fs.readFileSync(path.join(opts.projectRoot, ".gentle-graph/profile.json"),"utf8")).profile;
  assert.deepEqual(profile.projects[0].references, ["src/MyApp.Application/MyApp.Application.csproj"]);
  assert.ok(graphImpact("OrderService",opts).affectedFiles.includes(vm));
  assert.ok(graphImpact("OrderService",opts).relatedTests.includes(test));
  for (const f of [view,vm]) assert.ok(graphImpact("SaveOrderCommand",opts).affectedFiles.includes(f));

  fs.writeFileSync(path.join(opts.projectRoot, ".gentle-graph/guide.json"), JSON.stringify({version:1,patterns:[],boundaries:["Seguir ADR-07"]}));
  const manual = formatGuide(graphGuide("order",opts));
  assert.match(manual,/BOUNDARIES: Seguir ADR-07/);
  assert.doesNotMatch(manual,/Domain sin dependencias/);
  fs.writeFileSync(path.join(opts.projectRoot,project),'<Project><PackageReference Include="Prism.Wpf"/></Project>');
  assert.match(formatGuide(graphGuide("order",opts)),/Prism/);
});

it("recommends a matching vertical slice and respects a manual architecture contract", t => {
  const opts = solution(t, {"Features/Orders/CreateOrderHandler.cs":"public class CreateOrderHandler : IRequestHandler<CreateOrder, Order> {}"});
  const guidance = graphGuide("agregar ordenes",opts);
  assert.match(guidance.architecture!,/Vertical Slice.*CQRS/);
  assert.match(guidance.suggestedPath[0],/Features\/Orders/);
  fs.mkdirSync(path.join(opts.projectRoot,"contracts"));
  fs.writeFileSync(path.join(opts.projectRoot,"contracts","placement.md"),"Los casos de uso nuevos van en Application.");
  clearMemoryCache(opts.projectRoot);
  const manual = graphGuide("agregar ordenes",opts);
  assert.equal(manual.slice,undefined);
  assert.match(formatGuide(manual),/contracts\/placement.md/);
});

it("detects web, Python, Go, Rust and hexagonal layouts from scoped evidence", t => {
  const opts = solution(t, {"package.json":'{"dependencies":{"@nestjs/core":"*","react":"*","next":"*"}}',
    "requirements.txt":"fastapi\ndjango","Cargo.toml":"[workspace]"});
  const files = ["app","pages","widgets","features/pay","entities","shared","controllers","services","components","hooks","cmd","internal","crates",
    "routers","schemas","core","ports","adapters"].map(s=>s+"/code.ts").concat("users/apps.py");
  const p = detectArchitecture(opts.projectRoot,files,["package.json","requirements.txt","Cargo.toml"]);
  for (const label of ["Feature-Sliced Design","NestJS Modules","Go standard layout","Rust Workspace","Hexagonal (Ports & Adapters)","FastAPI routers","Django apps"]) assert.ok(p.architectures.includes(label),label);
  assert.ok(p.frameworks.includes("Next.js"));
});

it("detects Spring Boot, Rails, Laravel and Symfony from scoped manifests", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"graph-manifests-"));
  try {
    const manifests={"pom.xml":"<project><groupId>org.springframework.boot</groupId></project>",
      "composer.json":JSON.stringify({require:{"laravel/framework":"*","symfony/framework-bundle":"*"}}),"Gemfile":"gem 'rails'"};
    for (const [file,source] of Object.entries(manifests)) fs.writeFileSync(path.join(root,file),source);
    const guide=graphGuide("modules",{projectRoot:root});
    for(const name of ["Spring Boot","Laravel","Symfony","Rails"]) assert(guide.architecture.includes(name),name);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
