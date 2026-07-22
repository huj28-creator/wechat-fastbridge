#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

static id AXAttr(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
    return CFBridgingRelease(value);
}

static NSString *AXString(AXUIElementRef element, CFStringRef name) {
    id value = AXAttr(element, name);
    return [value isKindOfClass:NSString.class] && [value length] ? value : nil;
}

static BOOL AXBool(AXUIElementRef element, CFStringRef name) {
    id value = AXAttr(element, name);
    return [value respondsToSelector:@selector(boolValue)] ? [value boolValue] : NO;
}

static NSRect AXFrame(AXUIElementRef element) {
    AXValueRef position = (__bridge AXValueRef)AXAttr(element, kAXPositionAttribute);
    AXValueRef size = (__bridge AXValueRef)AXAttr(element, kAXSizeAttribute);
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    if (!position || !size || !AXValueGetValue(position, kAXValueCGPointType, &point) || !AXValueGetValue(size, kAXValueCGSizeType, &dimensions)) return NSZeroRect;
    return NSMakeRect(point.x, point.y, dimensions.width, dimensions.height);
}

static NSArray<NSString *> *AXStrings(AXUIElementRef element) {
    NSMutableOrderedSet<NSString *> *values = [NSMutableOrderedSet orderedSet];
    for (id name in @[(__bridge id)kAXValueAttribute, (__bridge id)kAXTitleAttribute, (__bridge id)kAXDescriptionAttribute, (__bridge id)kAXHelpAttribute]) {
        NSString *value = AXString(element, (__bridge CFStringRef)name);
        if (value.length) [values addObject:value];
    }
    return values.array;
}

static NSArray *AXChildren(AXUIElementRef element) {
    id value = AXAttr(element, kAXChildrenAttribute);
    return [value isKindOfClass:NSArray.class] ? value : @[];
}

static NSDictionary *LegacyNode(AXUIElementRef element) {
    NSString *role = AXString(element, kAXRoleAttribute) ?: @"";
    BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole];
    BOOL textInput = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
    BOOL needsStrings = YES;
    Boolean settable = false;
    if (textInput) AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
    return @{
        @"element": (__bridge id)element, @"role": role,
        @"strings": needsStrings ? AXStrings(element) : @[],
        @"selected": @(rowOrCell ? AXBool(element, kAXSelectedAttribute) : NO),
        @"settable": @(settable), @"frame": [NSValue valueWithRect:AXFrame(element)],
    };
}

static NSDictionary *NodeAndChildren(AXUIElementRef element, NSArray **childrenOut) {
    NSArray *attributes = @[
        (__bridge id)kAXRoleAttribute, (__bridge id)kAXChildrenAttribute,
        (__bridge id)kAXValueAttribute, (__bridge id)kAXTitleAttribute,
        (__bridge id)kAXDescriptionAttribute, (__bridge id)kAXHelpAttribute,
        (__bridge id)kAXSelectedAttribute, (__bridge id)kAXPositionAttribute,
        (__bridge id)kAXSizeAttribute,
    ];
    CFArrayRef copied = NULL;
    AXError error = AXUIElementCopyMultipleAttributeValues(
        element, (__bridge CFArrayRef)attributes, 0, &copied
    );
    if (error != kAXErrorSuccess || !copied) {
        if (childrenOut) *childrenOut = AXChildren(element);
        return LegacyNode(element);
    }
    NSArray *values = CFBridgingRelease(copied);
    id (^at)(NSUInteger) = ^id(NSUInteger index) {
        if (index >= values.count) return nil;
        id value = values[index];
        return value == NSNull.null ? nil : value;
    };
    NSString *role = [at(0) isKindOfClass:NSString.class] ? at(0) : @"";
    NSArray *children = [at(1) isKindOfClass:NSArray.class] ? at(1) : @[];
    if (childrenOut) *childrenOut = children;
    BOOL rowOrCell = [role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole];
    BOOL textInput = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
    BOOL needsStrings = YES;
    NSMutableOrderedSet *strings = [NSMutableOrderedSet orderedSet];
    if (needsStrings) for (NSUInteger index = 2; index <= 5; index++) {
        id value = at(index);
        if ([value isKindOfClass:NSString.class] && [value length]) [strings addObject:value];
    }
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    id position = at(7);
    id size = at(8);
    if (position && CFGetTypeID((__bridge CFTypeRef)position) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &point);
    if (size && CFGetTypeID((__bridge CFTypeRef)size) == AXValueGetTypeID()) AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions);
    Boolean settable = false;
    if (textInput) AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable);
    return @{
        @"element": (__bridge id)element,
        @"role": role,
        @"strings": strings.array,
        @"selected": @(rowOrCell && [at(6) respondsToSelector:@selector(boolValue)] ? [at(6) boolValue] : NO),
        @"settable": @(settable),
        @"frame": [NSValue valueWithRect:NSMakeRect(point.x, point.y, dimensions.width, dimensions.height)],
    };
}

static NSArray<NSDictionary *> *Walk(AXUIElementRef root, NSUInteger limit) {
    NSMutableArray *queue = [NSMutableArray arrayWithObject:(__bridge id)root];
    NSMutableArray *nodes = [NSMutableArray array];
    for (NSUInteger cursor = 0; cursor < queue.count && nodes.count < limit; cursor++) {
        AXUIElementRef element = (__bridge AXUIElementRef)queue[cursor];
        NSArray *children = nil;
        [nodes addObject:NodeAndChildren(element, &children)];
        [queue addObjectsFromArray:children ?: @[]];
    }
    return nodes;
}

static NSArray<NSString *> *SubtreeStrings(AXUIElementRef element) {
    NSMutableOrderedSet *values = [NSMutableOrderedSet orderedSet];
    for (NSDictionary *node in Walk(element, 100)) [values addObjectsFromArray:node[@"strings"]];
    return values.array;
}

static BOOL ExactHeader(NSString *value, NSString *chat) {
    if ([value isEqualToString:chat]) return YES;
    NSString *pattern = [NSString stringWithFormat:@"^%@ \\(\\d+\\)$", [NSRegularExpression escapedPatternForString:chat]];
    return [value rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}

static NSString *FNV1a(NSString *value) {
    uint32_t hash = 2166136261u;
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *bytes = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) hash = (hash ^ bytes[i]) * 16777619u;
    return [NSString stringWithFormat:@"%08x", hash];
}

static BOOL IsMessageNoise(NSString *value, NSString *chat) {
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!trimmed.length || [trimmed isEqualToString:@"Field"] || ExactHeader(trimmed, chat)) return YES;
    NSRegularExpression *time = [NSRegularExpression regularExpressionWithPattern:@"^(昨天 )?\\d{1,2}:\\d{2}$" options:0 error:nil];
    return [time firstMatchInString:trimmed options:0 range:NSMakeRange(0, trimmed.length)] != nil;
}

static void Emit(NSDictionary *value, FILE *stream) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fprintf(stream, "%s\n", [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
}

static void Fail(NSString *code, NSString *detail) {
    Emit(@{@"ok": @NO, @"error": code, @"detail": detail ?: @""}, stderr);
    exit(2);
}

static NSDictionary *AXDiagnostic(AXUIElementRef root, CFStringRef attribute) {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(root, attribute, &value);
    NSUInteger count = value && CFGetTypeID(value) == CFArrayGetTypeID() ? CFArrayGetCount(value) : (value ? 1 : 0);
    if (value) CFRelease(value);
    return @{@"error": @(error), @"count": @(count)};
}

static NSString *Option(NSArray<NSString *> *args, NSString *name) {
    NSUInteger index = [args indexOfObject:name];
    return index != NSNotFound && index + 1 < args.count ? args[index + 1] : nil;
}

static void PostKey(CGEventSourceRef source, CGKeyCode key, CGEventFlags flags) {
    CGEventRef down = CGEventCreateKeyboardEvent(source, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, key, false);
    CGEventSetFlags(down, flags); CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
    CFRelease(down); CFRelease(up);
}

static void PostKeyToPid(CGEventSourceRef source, pid_t pid, CGKeyCode key, CGEventFlags flags) {
    CGEventRef down = CGEventCreateKeyboardEvent(source, key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, key, false);
    CGEventSetFlags(down, flags); CGEventSetFlags(up, flags);
    CGEventPostToPid(pid, down); CGEventPostToPid(pid, up);
    CFRelease(down); CFRelease(up);
}

static id ParentTableObject(AXUIElementRef element) {
    id current = (__bridge id)element;
    for (NSUInteger depth = 0; depth < 8; depth++) {
        id parent = AXAttr((__bridge AXUIElementRef)current, kAXParentAttribute);
        if (!parent) return nil;
        NSString *role = AXString((__bridge AXUIElementRef)parent, kAXRoleAttribute);
        if ([role isEqualToString:(__bridge NSString *)kAXTableRole]) return parent;
        current = parent;
    }
    return nil;
}

static void OpenExactChat(NSRunningApplication *app, NSString *chat) {
    [app activateWithOptions:0];
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    PostKey(source, 3, kCGEventFlagMaskCommand);
    usleep(120000);
    PostKey(source, 0, kCGEventFlagMaskCommand);
    usleep(40000);
    NSUInteger length = chat.length;
    UniChar *characters = calloc(length, sizeof(UniChar));
    [chat getCharacters:characters range:NSMakeRange(0, length)];
    CGEventRef typeDown = CGEventCreateKeyboardEvent(source, 0, true);
    CGEventRef typeUp = CGEventCreateKeyboardEvent(source, 0, false);
    CGEventKeyboardSetUnicodeString(typeDown, length, characters);
    CGEventKeyboardSetUnicodeString(typeUp, length, characters);
    CGEventPost(kCGHIDEventTap, typeDown); CGEventPost(kCGHIDEventTap, typeUp);
    CFRelease(typeDown); CFRelease(typeUp); free(characters);
    usleep(220000);
    PostKey(source, 36, 0);
    CFRelease(source);
    usleep(900000);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDate *started = NSDate.date;
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];
        NSString *command = args.firstObject;
        if (!command) Fail(@"USAGE", @"status|snapshot|send");
        if (!AXIsProcessTrusted()) Fail(@"ACCESSIBILITY_PERMISSION_REQUIRED", @"Enable Accessibility for Codex or Terminal");
        NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.tencent.xinWeChat"];
        NSRunningApplication *app = apps.firstObject;
        if (!app) Fail(@"WECHAT_NOT_RUNNING", @"Open WeChat first");
        if ([command isEqualToString:@"debug"]) {
            NSMutableArray *diagnostics = [NSMutableArray array];
            for (NSRunningApplication *candidate in apps) {
                AXUIElementRef root = AXUIElementCreateApplication(candidate.processIdentifier);
                [diagnostics addObject:@{
                    @"pid": @(candidate.processIdentifier),
                    @"windows": AXDiagnostic(root, kAXWindowsAttribute),
                    @"children": AXDiagnostic(root, kAXChildrenAttribute),
                    @"focusedWindow": AXDiagnostic(root, kAXFocusedWindowAttribute),
                    @"role": AXDiagnostic(root, kAXRoleAttribute),
                }];
                CFRelease(root);
            }
            Emit(@{@"ok": @YES, @"trusted": @(AXIsProcessTrusted()), @"apps": diagnostics}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"status"]) {
            Emit(@{@"ok": @YES, @"pid": @(app.processIdentifier), @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }

        NSString *chat = Option(args, @"--chat");
        if (!chat.length) Fail(@"CHAT_REQUIRED", @"Pass the exact chat title");
        NSInteger limit = MAX(1, MIN(20, [Option(args, @"--limit") ?: @"8" integerValue]));
        NSArray<NSDictionary *> *nodes = nil;
        NSDictionary *window = nil;
        for (NSRunningApplication *candidate in apps) {
            AXUIElementRef root = AXUIElementCreateApplication(candidate.processIdentifier);
            NSArray *windowElements = AXAttr(root, kAXWindowsAttribute);
            NSMutableArray<NSDictionary *> *candidateNodes = [NSMutableArray array];
            if ([windowElements isKindOfClass:NSArray.class]) {
                for (id windowElement in windowElements) {
                    [candidateNodes addObjectsFromArray:Walk((__bridge AXUIElementRef)windowElement, 1200 - candidateNodes.count)];
                    if (candidateNodes.count >= 1200) break;
                }
            }
            if (!candidateNodes.count) {
                id focusedWindow = AXAttr(root, kAXFocusedWindowAttribute);
                if (focusedWindow) [candidateNodes addObjectsFromArray:Walk((__bridge AXUIElementRef)focusedWindow, 1200)];
            }
            if (!candidateNodes.count) [candidateNodes addObjectsFromArray:Walk(root, 1200)];
            CFRelease(root);
            for (NSDictionary *node in candidateNodes) {
                if ([node[@"role"] isEqualToString:(__bridge NSString *)kAXWindowRole] && !NSEqualRects([node[@"frame"] rectValue], NSZeroRect)) {
                    app = candidate;
                    nodes = candidateNodes;
                    window = node;
                    break;
                }
            }
            if (window) break;
        }
        if (!window) Fail(@"WECHAT_WINDOW_NOT_FOUND", @"Open the main chat window");
        NSRect windowFrame = [window[@"frame"] rectValue];
        BOOL (^rightPane)(NSDictionary *) = ^BOOL(NSDictionary *node) {
            NSRect frame = [node[@"frame"] rectValue];
            return !NSEqualRects(frame, NSZeroRect) && NSMidX(frame) > NSMidX(windowFrame) && NSIntersectsRect(frame, windowFrame);
        };

        BOOL selectedMatched = NO;
        BOOL headerMatched = NO;
        NSDictionary *input = nil;
        NSMutableOrderedSet<NSString *> *messages = [NSMutableOrderedSet orderedSet];
        NSMutableArray *inspectSelected = [NSMutableArray array];
        NSMutableArray *inspectHeaders = [NSMutableArray array];
        NSMutableArray *inspectInputs = [NSMutableArray array];
        NSMutableArray *inspectText = [NSMutableArray array];
        NSMutableArray *inspectRight = [NSMutableArray array];
        NSDictionary *targetRow = nil;
        AXError selectionSetError = kAXErrorSuccess;
        AXError selectionPressError = kAXErrorSuccess;
        for (NSDictionary *node in nodes) {
            NSString *role = node[@"role"];
            NSArray<NSString *> *strings = node[@"strings"];
            if (!targetRow && [role isEqualToString:(__bridge NSString *)kAXRowRole]) {
                for (NSString *value in strings) {
                    if ([value isEqualToString:chat] || [value hasPrefix:[chat stringByAppendingString:@","]]) { targetRow = node; break; }
                }
            }
            if (strings.count && inspectText.count < 120) {
                NSRect inspectFrame = [node[@"frame"] rectValue];
                [inspectText addObject:@{@"role": role, @"strings": strings,
                    @"x": @(inspectFrame.origin.x), @"y": @(inspectFrame.origin.y),
                    @"w": @(inspectFrame.size.width), @"h": @(inspectFrame.size.height)}];
            }
            if ([node[@"selected"] boolValue] && ([role isEqualToString:(__bridge NSString *)kAXRowRole] || [role isEqualToString:(__bridge NSString *)kAXCellRole])) {
                NSArray *subtree = SubtreeStrings((__bridge AXUIElementRef)node[@"element"]);
                if (inspectSelected.count < 10) [inspectSelected addObject:subtree];
                for (NSString *value in subtree) {
                    if ([value isEqualToString:chat] || [value hasPrefix:[chat stringByAppendingString:@","]]) selectedMatched = YES;
                }
            }
            if (rightPane(node) && [role isEqualToString:(__bridge NSString *)kAXStaticTextRole]) {
                if (inspectHeaders.count < 20 && strings.count) [inspectHeaders addObject:strings];
                for (NSString *value in strings) if (ExactHeader(value, chat)) headerMatched = YES;
            }
            NSRect frame = [node[@"frame"] rectValue];
            if (rightPane(node) && [node[@"settable"] boolValue] &&
                ([role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole]) && NSMidY(frame) > NSMidY(windowFrame)) {
                if (inspectInputs.count < 10) [inspectInputs addObject:@{@"role": role, @"strings": strings}];
                for (NSString *value in strings) if (ExactHeader(value, chat)) headerMatched = YES;
                if (!input || NSMidY(frame) > NSMidY([input[@"frame"] rectValue])) input = node;
            }
            BOOL isInputRole = [role isEqualToString:(__bridge NSString *)kAXTextAreaRole] || [role isEqualToString:(__bridge NSString *)kAXTextFieldRole];
            if (rightPane(node) && !isInputRole) for (NSString *value in strings) {
                if (!IsMessageNoise(value, chat)) {
                    [messages addObject:[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]];
                    if (inspectRight.count < 40) [inspectRight addObject:@{@"role": role, @"value": value}];
                }
            }
        }
        if ((!selectedMatched || !headerMatched) && targetRow &&
            ([command isEqualToString:@"send"] || [command isEqualToString:@"select"])) {
            AXUIElementRef rowElement = (__bridge AXUIElementRef)targetRow[@"element"];
            id tableObject = ParentTableObject(rowElement);
            selectionSetError = tableObject ? AXUIElementSetAttributeValue(
                (__bridge AXUIElementRef)tableObject, kAXSelectedRowsAttribute, (__bridge CFArrayRef)@[targetRow[@"element"]]
            ) : kAXErrorNoValue;
            NSRect rowFrame = [targetRow[@"frame"] rectValue];
            CGFloat screenTop = NSMaxY(NSScreen.mainScreen.frame);
            CGPoint clickPoint = CGPointMake(NSMidX(rowFrame), screenTop - NSMidY(rowFrame));
            CGEventRef mouseDown = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, clickPoint, kCGMouseButtonLeft);
            CGEventRef mouseUp = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, clickPoint, kCGMouseButtonLeft);
            CGEventPostToPid(app.processIdentifier, mouseDown); CGEventPostToPid(app.processIdentifier, mouseUp);
            CFRelease(mouseDown); CFRelease(mouseUp);
            AXError selectError = kAXErrorSuccess;
            if (selectError == kAXErrorSuccess) {
                for (NSUInteger attempt = 0; attempt < 12; attempt++) {
                    usleep(100000);
                    selectedMatched = AXBool(rowElement, kAXSelectedAttribute);
                    headerMatched = NO;
                    if (input) for (NSString *value in AXStrings((__bridge AXUIElementRef)input[@"element"])) {
                        if (ExactHeader(value, chat)) headerMatched = YES;
                    }
                    if (selectedMatched && headerMatched) break;
                }
            }
        }
        if ([command isEqualToString:@"select"] && selectedMatched && headerMatched) {
            Emit(@{@"ok": @YES, @"chat": chat, @"selected": @YES,
                   @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"select"] && (!selectedMatched || !headerMatched)) {
            Fail(@"WECHAT_SELECT_FAILED", [NSString stringWithFormat:@"set=%d press=%d selected=%d header=%d", selectionSetError, selectionPressError, selectedMatched, headerMatched]);
        }
        if ([command isEqualToString:@"inspect"]) {
            Emit(@{@"ok": @YES, @"chat": chat, @"scanMs": @(-started.timeIntervalSinceNow * 1000),
                   @"selected": inspectSelected, @"rightPaneStaticText": inspectHeaders, @"inputs": inspectInputs,
                   @"textNodes": inspectText, @"rightPaneText": inspectRight,
                   @"selectedMatched": @(selectedMatched), @"headerMatched": @(headerMatched), @"nodeCount": @(nodes.count)}, stdout);
            return 0;
        }
        if (!selectedMatched || !headerMatched) Fail(@"WECHAT_TARGET_MISMATCH", [@"Select the exact chat: " stringByAppendingString:chat]);
        if (!input) Fail(@"WECHAT_INPUT_NOT_FOUND", chat);
        NSArray *allMessages = messages.array;
        NSArray *recent = allMessages.count > limit ? [allMessages subarrayWithRange:NSMakeRange(allMessages.count - limit, limit)] : allMessages;
        NSString *signature = FNV1a([recent componentsJoinedByString:@"\n"]);
        if ([command isEqualToString:@"snapshot"]) {
            Emit(@{@"ok": @YES, @"chat": chat, @"messages": recent, @"signature": signature,
                   @"inputReady": @YES, @"selectedChatMatched": @YES, @"headerMatched": @YES,
                   @"scanMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        if ([command isEqualToString:@"send"]) {
            NSString *text = Option(args, @"--text");
            if (![text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) Fail(@"TEXT_REQUIRED", @"Pass non-empty --text");
            AXUIElementRef inputElement = (__bridge AXUIElementRef)input[@"element"];
            if (AXUIElementSetAttributeValue(inputElement, kAXFocusedAttribute, kCFBooleanTrue) != kAXErrorSuccess ||
                AXUIElementSetAttributeValue(inputElement, kAXValueAttribute, (__bridge CFTypeRef)text) != kAXErrorSuccess) Fail(@"WECHAT_INPUT_WRITE_FAILED", chat);
            CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
            NSString *shortcut = @"AXConfirm";
            AXUIElementPerformAction(inputElement, kAXConfirmAction);
            usleep(160000);
            NSString *remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Return";
                PostKeyToPid(source, app.processIdentifier, 36, 0);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Command+Return";
                PostKeyToPid(source, app.processIdentifier, 36, kCGEventFlagMaskCommand);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                shortcut = @"Control+Return";
                PostKeyToPid(source, app.processIdentifier, 36, kCGEventFlagMaskControl);
                usleep(160000);
                remaining = AXString(inputElement, kAXValueAttribute) ?: @"";
            }
            CFRelease(source);
            if ([remaining stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length) {
                Fail(@"WECHAT_SEND_SHORTCUT_UNKNOWN", @"Message remains in the input box; nothing was reported as sent");
            }
            Emit(@{@"ok": @YES, @"chat": chat, @"sent": text, @"signature": signature,
                   @"shortcut": shortcut, @"inputCleared": @YES,
                   @"latencyMs": @(-started.timeIntervalSinceNow * 1000)}, stdout);
            return 0;
        }
        Fail(@"UNKNOWN_COMMAND", command);
    }
}
